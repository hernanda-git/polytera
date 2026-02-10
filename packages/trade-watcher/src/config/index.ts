import { loadEnv, type Env } from './env.js';
import {
  CTF_EXCHANGE_ADDRESS,
  NEG_RISK_CTF_EXCHANGE_ADDRESS,
  USDC_ADDRESS,
} from './contracts.js';

export interface AppConfig {
  env: Env;
  contracts: {
    ctfExchange: `0x${string}`;
    negRiskCtfExchange: `0x${string}`;
    usdc: `0x${string}`;
  };
  expertAddress: `0x${string}`;
}

export function loadConfig(): AppConfig {
  const env = loadEnv();

  return {
    env,
    contracts: {
      ctfExchange: CTF_EXCHANGE_ADDRESS,
      negRiskCtfExchange: NEG_RISK_CTF_EXCHANGE_ADDRESS,
      usdc: USDC_ADDRESS,
    },
    expertAddress: env.EXPERT_ADDRESS.toLowerCase() as `0x${string}`,
  };
}

export { loadEnv, type Env } from './env.js';
