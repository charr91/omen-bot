export type FillSide = 'BUY' | 'SELL';
export type FillOutcome = 'YES' | 'NO';
export type FillOrderType = 'TAKER' | 'MAKER' | 'UNKNOWN';

export interface NewFill {
  id: string;
  marketId: string;
  tokenId: string;
  walletAddress: string;
  side: FillSide;
  outcome: FillOutcome;
  price: string;
  shares: string;
  sizeUsd: string;
  txHash: string;
  orderType: FillOrderType;
  timestamp: Date;
}

export interface FillRecord extends NewFill {
  analyzed: boolean;
  createdAt: Date;
}
