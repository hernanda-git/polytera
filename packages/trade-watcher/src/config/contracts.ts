// ─── Polymarket Contract Addresses (Polygon Mainnet) ─────────────────────────

export const CTF_EXCHANGE_ADDRESS =
  '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E' as const;

export const NEG_RISK_CTF_EXCHANGE_ADDRESS =
  '0xC5d563A36AE78145C45a50134d48A1215220f80a' as const;

export const USDC_ADDRESS =
  '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as const;

// ─── OrderFilled Event ABI ───────────────────────────────────────────────────
// Emitted by both CTF Exchange and NegRisk CTF Exchange when an order is filled.
// Using `const` assertion so viem can infer full event types.

export const ORDER_FILLED_ABI = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'bytes32',
        name: 'orderHash',
        type: 'bytes32',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'maker',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'taker',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'makerAssetId',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'takerAssetId',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'makerAmountFilled',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'takerAmountFilled',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'fee',
        type: 'uint256',
      },
    ],
    name: 'OrderFilled',
    type: 'event',
  },
] as const;

// ─── Polygon Chain Config ────────────────────────────────────────────────────

export const POLYGON_CHAIN_ID = 137;

/**
 * Maximum block range per getLogs request (Polygon RPC providers typically
 * support up to 10 000 blocks per query).
 */
export const MAX_BLOCK_RANGE = 5_000n;
