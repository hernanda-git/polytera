import {
  createPublicClient,
  webSocket,
  http,
  type PublicClient,
  type WatchContractEventReturnType,
  type Log,
  type GetContractEventsReturnType,
} from 'viem';
import { polygon } from 'viem/chains';
import { BaseWatcher } from './base-watcher.js';
import type { RawTradeEvent, ExchangeType } from '../types/index.js';
import { buildEventId } from '../types/index.js';
import {
  ORDER_FILLED_ABI,
  CTF_EXCHANGE_ADDRESS,
  NEG_RISK_CTF_EXCHANGE_ADDRESS,
  MAX_BLOCK_RANGE,
} from '../config/contracts.js';
import type { EventStore } from '../store/event-store.js';
import { createChildLogger } from '../utils/logger.js';
import { withRetry, sleep } from '../utils/retry.js';

const log = createChildLogger({ module: 'on-chain-watcher' });

type OrderFilledLog = Log<bigint, number, false, typeof ORDER_FILLED_ABI[0], true>;

interface OnChainWatcherConfig {
  wssUrl: string;
  httpUrl: string;
  expertAddress: `0x${string}`;
  eventStore: EventStore;
}

/**
 * Primary data source: watches both CTF Exchange and NegRisk CTF Exchange
 * contracts on Polygon for OrderFilled events involving the expert address.
 *
 * Uses WebSocket transport for real-time detection.
 * Backfills missed blocks on startup using HTTP transport.
 */
export class OnChainWatcher extends BaseWatcher {
  private wsClient: PublicClient | null = null;
  private httpClient: PublicClient | null = null;
  private unwatchFns: WatchContractEventReturnType[] = [];
  private config: OnChainWatcherConfig;
  private isShuttingDown = false;

  constructor(config: OnChainWatcherConfig) {
    super('on-chain');
    this.config = config;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.state === 'running') return;
    this.setState('starting');
    this.startedAt = Date.now();
    this.isShuttingDown = false;

    try {
      // Create HTTP client for backfill and block queries
      this.httpClient = createPublicClient({
        chain: polygon,
        transport: http(this.config.httpUrl),
      });

      // Backfill any missed blocks since last run
      await this.backfillMissedBlocks();

      // Create WebSocket client for real-time events
      this.wsClient = createPublicClient({
        chain: polygon,
        transport: webSocket(this.config.wssUrl, {
          reconnect: {
            attempts: 10,
            delay: 2_000,
          },
        }),
      });

      // Start watchers on both exchange contracts
      this.watchExchange(CTF_EXCHANGE_ADDRESS, 'ctf');
      this.watchExchange(NEG_RISK_CTF_EXCHANGE_ADDRESS, 'neg-risk');

      this.setState('running');
      log.info('On-chain watcher started — listening for OrderFilled events');
    } catch (err) {
      this.setState('failed');
      const error = err instanceof Error ? err : new Error(String(err));
      log.error({ err: error }, 'Failed to start on-chain watcher');
      this.emitError(error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.isShuttingDown = true;
    log.info('Stopping on-chain watcher...');

    // Unsubscribe from all contract event watchers
    for (const unwatch of this.unwatchFns) {
      try {
        unwatch();
      } catch {
        // Ignore unwatch errors during shutdown
      }
    }
    this.unwatchFns = [];
    this.wsClient = null;
    this.httpClient = null;

    this.setState('stopped');
    log.info('On-chain watcher stopped');
  }

  // ─── Exchange Watcher Setup ──────────────────────────────────────────

  private watchExchange(
    address: `0x${string}`,
    exchange: ExchangeType
  ): void {
    if (!this.wsClient) {
      throw new Error('WebSocket client not initialized');
    }

    const expertLower = this.config.expertAddress.toLowerCase();

    const unwatch = this.wsClient.watchContractEvent({
      address,
      abi: ORDER_FILLED_ABI,
      eventName: 'OrderFilled',
      onLogs: (logs) => {
        for (const rawLog of logs) {
          try {
            this.processLog(rawLog as OrderFilledLog, exchange, expertLower);
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(
              { err: error, txHash: rawLog.transactionHash },
              'Error processing log'
            );
            this.emitError(error);
          }
        }
      },
      onError: (err) => {
        if (this.isShuttingDown) return;
        const error = err instanceof Error ? err : new Error(String(err));
        log.error({ err: error, exchange }, 'WebSocket watcher error');
        this.errorCount++;

        // If we're still supposed to be running, enter reconnecting state
        if (this.state === 'running') {
          this.setState('reconnecting');
          this.scheduleReconnect(address, exchange);
        }
      },
    });

    this.unwatchFns.push(unwatch);
    log.info({ address, exchange }, 'Watching exchange for OrderFilled events');
  }

  // ─── Log Processing ──────────────────────────────────────────────────

  private processLog(
    rawLog: OrderFilledLog,
    exchange: ExchangeType,
    expertLower: string
  ): void {
    // The OrderFilled event has maker and taker as indexed (topic) params
    const maker = (rawLog.args.maker ?? '').toLowerCase();
    const taker = (rawLog.args.taker ?? '').toLowerCase();

    // Filter: only process if expert is involved
    const isMaker = maker === expertLower;
    const isTaker = taker === expertLower;
    if (!isMaker && !isTaker) return;

    const txHash = rawLog.transactionHash;
    const logIndex = rawLog.logIndex;

    if (!txHash || logIndex === null || logIndex === undefined) {
      log.warn({ rawLog }, 'Missing txHash or logIndex — skipping');
      return;
    }

    const event: RawTradeEvent = {
      id: buildEventId(txHash, logIndex),
      txHash,
      logIndex,
      blockNumber: rawLog.blockNumber ?? 0n,
      blockTimestamp: 0, // Will be enriched below
      detectedAt: Date.now(),
      source: 'on-chain',
      exchange,
      orderHash: rawLog.args.orderHash ?? '0x',
      maker,
      taker,
      makerAssetId: (rawLog.args.makerAssetId ?? 0n).toString(),
      takerAssetId: (rawLog.args.takerAssetId ?? 0n).toString(),
      makerAmountFilled: rawLog.args.makerAmountFilled ?? 0n,
      takerAmountFilled: rawLog.args.takerAmountFilled ?? 0n,
      fee: rawLog.args.fee ?? 0n,
      expertSide: isMaker ? 'maker' : 'taker',
    };

    // Update last seen block
    if (
      rawLog.blockNumber !== null &&
      rawLog.blockNumber !== undefined &&
      (this.lastBlockSeen === null || rawLog.blockNumber > this.lastBlockSeen)
    ) {
      this.lastBlockSeen = rawLog.blockNumber;
    }

    // Enrich block timestamp asynchronously (non-blocking)
    this.enrichTimestamp(event).then((enriched) => {
      this.emitTrade(enriched);
    });
  }

  /**
   * Fetch the block timestamp and attach it to the event.
   * Falls back to detection time if block fetch fails.
   */
  private async enrichTimestamp(event: RawTradeEvent): Promise<RawTradeEvent> {
    try {
      const client = this.httpClient ?? this.wsClient;
      if (client && event.blockNumber > 0n) {
        const block = await client.getBlock({
          blockNumber: event.blockNumber,
        });
        return {
          ...event,
          blockTimestamp: Number(block.timestamp),
        };
      }
    } catch (err) {
      log.warn(
        { blockNumber: event.blockNumber.toString(), err },
        'Failed to fetch block timestamp — using detection time'
      );
    }
    return {
      ...event,
      blockTimestamp: Math.floor(event.detectedAt / 1000),
    };
  }

  // ─── Backfill ────────────────────────────────────────────────────────

  /**
   * On startup, backfill any blocks that were missed while the watcher
   * was offline. Uses the latest block number from the event store.
   */
  private async backfillMissedBlocks(): Promise<void> {
    const lastBlock = this.config.eventStore.getLatestBlockNumber();
    if (lastBlock === null) {
      log.info('No previous events in store — skipping backfill');
      return;
    }

    const client = this.httpClient;
    if (!client) return;

    const currentBlock = await withRetry(() => client.getBlockNumber(), {
      label: 'getBlockNumber',
    });

    const fromBlock = lastBlock + 1n;
    if (fromBlock > currentBlock) {
      log.info('No missed blocks to backfill');
      return;
    }

    log.info(
      {
        fromBlock: fromBlock.toString(),
        toBlock: currentBlock.toString(),
        blocksToBackfill: (currentBlock - fromBlock + 1n).toString(),
      },
      'Backfilling missed blocks'
    );

    // Process in chunks to respect RPC limits
    await this.backfillExchange(
      client,
      CTF_EXCHANGE_ADDRESS,
      'ctf',
      fromBlock,
      currentBlock
    );
    await this.backfillExchange(
      client,
      NEG_RISK_CTF_EXCHANGE_ADDRESS,
      'neg-risk',
      fromBlock,
      currentBlock
    );

    log.info('Backfill complete');
  }

  private async backfillExchange(
    client: PublicClient,
    address: `0x${string}`,
    exchange: ExchangeType,
    fromBlock: bigint,
    toBlock: bigint
  ): Promise<void> {
    const expertLower = this.config.expertAddress.toLowerCase();
    let cursor = fromBlock;

    while (cursor <= toBlock) {
      const chunkEnd =
        cursor + MAX_BLOCK_RANGE - 1n > toBlock
          ? toBlock
          : cursor + MAX_BLOCK_RANGE - 1n;

      try {
        // Fetch logs for maker = expert
        const makerLogs = await withRetry(
          () =>
            client.getContractEvents({
              address,
              abi: ORDER_FILLED_ABI,
              eventName: 'OrderFilled',
              args: { maker: this.config.expertAddress },
              fromBlock: cursor,
              toBlock: chunkEnd,
            }),
          { label: `backfill-maker-${exchange}` }
        );

        // Fetch logs for taker = expert
        const takerLogs = await withRetry(
          () =>
            client.getContractEvents({
              address,
              abi: ORDER_FILLED_ABI,
              eventName: 'OrderFilled',
              args: { taker: this.config.expertAddress },
              fromBlock: cursor,
              toBlock: chunkEnd,
            }),
          { label: `backfill-taker-${exchange}` }
        );

        const allLogs = [...makerLogs, ...takerLogs];

        for (const rawLog of allLogs) {
          this.processLog(rawLog as OrderFilledLog, exchange, expertLower);
        }

        if (allLogs.length > 0) {
          log.debug(
            {
              exchange,
              fromBlock: cursor.toString(),
              toBlock: chunkEnd.toString(),
              events: allLogs.length,
            },
            'Backfill chunk processed'
          );
        }
      } catch (err) {
        log.error(
          {
            err,
            exchange,
            fromBlock: cursor.toString(),
            toBlock: chunkEnd.toString(),
          },
          'Backfill chunk failed — continuing'
        );
      }

      cursor = chunkEnd + 1n;
    }
  }

  // ─── Reconnection ───────────────────────────────────────────────────

  private async scheduleReconnect(
    address: `0x${string}`,
    exchange: ExchangeType
  ): Promise<void> {
    // Wait before attempting reconnection
    await sleep(5_000);
    if (this.isShuttingDown) return;

    try {
      log.info({ exchange }, 'Attempting reconnection...');

      // Recreate WebSocket client
      this.wsClient = createPublicClient({
        chain: polygon,
        transport: webSocket(this.config.wssUrl, {
          reconnect: {
            attempts: 10,
            delay: 2_000,
          },
        }),
      });

      // Backfill any blocks missed during downtime
      await this.backfillMissedBlocks();

      // Re-establish watchers
      this.unwatchFns = [];
      this.watchExchange(CTF_EXCHANGE_ADDRESS, 'ctf');
      this.watchExchange(NEG_RISK_CTF_EXCHANGE_ADDRESS, 'neg-risk');

      this.setState('running');
      log.info('Reconnected successfully');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error({ err: error }, 'Reconnection failed');
      this.emitError(error);
      // Will try again on next error
    }
  }
}
