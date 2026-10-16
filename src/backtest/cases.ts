/**
 * M2 backtest set: publicly reported insider-style Polymarket cases plus comparable control markets with no reported
 * insider activity. Times are UTC. `newsAt` is the first public signal of the outcome (a conservative cut-off: alerts
 * must land before it to count). `windowStart` is when replay begins (insider entries reported after it).
 */
export interface BacktestCase {
  id: string;
  kind: 'insider' | 'control';
  title: string;
  conditionId: string;
  /** Outcome that won (the side an insider would hold). */
  winningOutcome: 'YES' | 'NO';
  windowStart: string;
  newsAt: string;
  newsNote: string;
  /** Display names / pseudonyms named in reporting (matched against data-api trade names). */
  reportedWallets?: string[];
  sources: { label: string; url: string }[];
}

export const BACKTEST_CASES: BacktestCase[] = [
  {
    id: 'nobel-machado-2025',
    kind: 'insider',
    title: 'Will María Corina Machado win the Nobel Peace Prize in 2025?',
    conditionId: '0x14a3dfeba8b22a32feb0f10763db68bc4d2abeb5bff90e9ae20de53793b35a1d',
    winningOutcome: 'YES',
    windowStart: '2025-10-07T09:00:00Z',
    newsAt: '2025-10-10T09:00:00Z',
    newsNote: 'Oslo announcement 11:00 CEST; bets spiked shortly after midnight Norwegian time',
    sources: [
      { label: 'Guardian, 2025-10-10', url: 'https://www.theguardian.com/world/2025/oct/10/nobel-peace-prize-bets-polymarket' },
      { label: 'Reuters, 2026-01-30', url: 'https://www.reuters.com/world/americas/nobel-committee-says-peace-prize-winner-likely-revealed-early-by-digital-spying-2026-01-30/' },
    ],
  },
  {
    id: 'openai-browser-oct31',
    kind: 'insider',
    title: 'OpenAI browser by October 31?',
    conditionId: '0xc25e15f39f776813870ee363ed483451add1c55dad163b18bdb2df653be2c90c',
    winningOutcome: 'YES',
    windowStart: '2025-10-17T00:00:00Z',
    newsAt: '2025-10-21T16:00:00Z',
    newsNote: 'ChatGPT Atlas launch livestream 2025-10-21 10:00 PT (cut-off 1h earlier for the teaser)',
    sources: [{ label: 'King & Spalding (new user bet $40k)', url: 'https://www.kslaw.com/insights/articles/new-trick-same-crime-insider-trading-on-prediction-markets' }],
  },
  {
    id: 'd4vd-year-in-search',
    kind: 'insider',
    title: 'Will d4vd be the #1 searched person on Google this year?',
    conditionId: '0xea17b1284d10617a57f910b2ea63bdef481b1724a4b899d454ff104bea67b657',
    winningOutcome: 'YES',
    windowStart: '2025-11-26T00:00:00Z',
    newsAt: '2025-12-04T08:00:00Z',
    newsNote: 'Year in Search 2025 published 2025-12-04 (cut-off 00:00 PT); AlphaRaccoon entered 2025-11-27',
    reportedWallets: ['AlphaRaccoon'],
    sources: [
      { label: 'Rolling Stone, 2026-05-28', url: 'https://www.rollingstone.com/music/music-news/google-staffer-insider-data-win-d4vd-bet-online-1235569669/' },
      { label: 'CFTC complaint 26-cv-4419', url: 'https://storage.courtlistener.com/recap/gov.uscourts.nysd.664905/gov.uscourts.nysd.664905.1.0.pdf' },
    ],
  },
  {
    id: 'maduro-out-jan31',
    kind: 'insider',
    title: 'Maduro out by January 31, 2026?',
    conditionId: '0x580adc1327de9bf7c179ef5aaffa3377bb5cb252b7d6390b027172d43fd6f993',
    winningOutcome: 'YES',
    windowStart: '2025-12-30T00:00:00Z',
    newsAt: '2026-01-03T06:00:00Z',
    newsNote: 'Strikes on Caracas reported ~02:00 local (06:00 UTC); Trump post 09:21 UTC',
    reportedWallets: ['Burdensome-Mix'],
    sources: [
      { label: 'CBS News', url: 'https://www.cbsnews.com/news/polymarket-maduro-capture-bet-400000/' },
      { label: 'NPR, 2026-01-05', url: 'https://www.npr.org/2026/01/05/nx-s1-5667232/polymarket-maduro-bet-insider-trading' },
      { label: 'Protos', url: 'https://protos.com/maduro-polymarket-bet-raises-insider-trading-concerns/' },
    ],
  },
  {
    id: 'us-strikes-iran-feb28',
    kind: 'insider',
    title: 'US strikes Iran by February 28, 2026?',
    conditionId: '0x3488f31e6449f9803f99a8b5dd232c7ad883637f1c86e6953305a2ef19c77f20',
    winningOutcome: 'YES',
    windowStart: '2026-02-25T06:30:00Z',
    newsAt: '2026-02-28T06:30:00Z',
    newsNote: 'First strike reports ~06:30 UTC (CENTCOM 06:35 UTC)',
    reportedWallets: ['Lettucehead718', 'suffix-295'],
    sources: [
      { label: 'Forbes, 2026-03-02', url: 'https://www.forbes.com/sites/boazsobrado/2026/03/02/fresh-wallets-made-12m-on-polymarket-hours-before-iran-airstrikes/' },
      { label: 'CoinDesk, 2026-02-28', url: 'https://www.coindesk.com/markets/2026/02/28/suspected-insiders-make-over-usd1-2-million-on-polymarket-ahead-of-u-s-strike-on-iran' },
    ],
  },
  {
    id: 'us-iran-ceasefire-apr7',
    kind: 'insider',
    title: 'US x Iran ceasefire by April 7?',
    conditionId: '0x4c5701bcde0b8fb7d7f48c8e9d20245a6caa58c61a77f981fad98f2bfa0b1bc7',
    winningOutcome: 'YES',
    windowStart: '2026-04-05T22:30:00Z',
    newsAt: '2026-04-07T22:30:00Z',
    newsNote: 'Trump Truth Social post ~18:30 ET',
    sources: [
      { label: 'AP News', url: 'https://apnews.com/article/polymarket-iran-trump-ceasefire-prediction-markets-350d9fe5ffefa74080ff5dd973aef48b' },
      { label: 'Reuters factbox, 2026-04-08', url: 'https://www.reuters.com/sustainability/boards-policy-regulation/some-trades-ahead-trump-policy-moves-raise-questions-2026-04-08/' },
    ],
  },
  {
    id: 'us-action-iran-jun21',
    kind: 'insider',
    title: 'US military action against Iran by Saturday? (2025-06-21)',
    conditionId: '0x6c6cff89b135f5684f5a25a98fd0335814d1bc411d08bfcf0be400db76ce511a',
    winningOutcome: 'YES',
    windowStart: '2025-06-18T23:50:00Z',
    newsAt: '2025-06-21T23:50:00Z',
    newsNote: 'Trump announced the Fordow/Natanz strikes ~19:50 ET',
    sources: [{ label: 'ACDC, Insider Risks in Polymarket Political Markets (Apr 2026)', url: 'https://acdatacollective.org/wp-content/uploads/2026/04/Insider_Risks_in_Polymarket_Political_Markets_ACDC.pdf' }],
  },
  // Controls: same families, no reported insider activity. Window = the same-length span before close.
  {
    id: 'ctl-maduro-out-2025',
    kind: 'control',
    title: 'Maduro out in 2025?',
    conditionId: '0xafc235557ace53ff0b0d2e93392314a7c3f3daab26a79050e985c11282f66df7',
    winningOutcome: 'NO',
    windowStart: '2025-12-28T00:00:00Z',
    newsAt: '2026-01-01T00:00:00Z',
    newsNote: 'Expired No at year end',
    sources: [{ label: 'Polymarket', url: 'https://polymarket.com/event/maduro-out-in-2025' }],
  },
  {
    id: 'ctl-maduro-out-nov30',
    kind: 'control',
    title: 'Maduro out by November 30, 2025?',
    conditionId: '0xa953bea944d7264285c0a2cc1f92809a7d9db78138b1c3de9cc23d8917f14d6a',
    winningOutcome: 'NO',
    windowStart: '2025-11-27T00:00:00Z',
    newsAt: '2025-12-01T00:00:00Z',
    newsNote: 'Expired No',
    sources: [{ label: 'Polymarket', url: 'https://polymarket.com/event/maduro-out-in-2025' }],
  },
  {
    id: 'ctl-openai-browser-sep30',
    kind: 'control',
    title: 'OpenAI browser by September 30?',
    conditionId: '0x097be0fa66524b5de5893630d4cb2f44a379e9c2d8b9b1372227e7f46e288b40',
    winningOutcome: 'NO',
    windowStart: '2025-09-26T00:00:00Z',
    newsAt: '2025-09-30T23:59:00Z',
    newsNote: 'Expired No',
    sources: [{ label: 'Polymarket', url: 'https://polymarket.com/event/openai-browser-by-september-30' }],
  },
  {
    id: 'ctl-trump-nobel-2025',
    kind: 'control',
    title: 'Will Donald Trump win the Nobel Peace Prize in 2025?',
    conditionId: '0x200369a7fc4dad910665c5a77e1c0c0d16237f79c637928bf0c5112cac2db708',
    winningOutcome: 'NO',
    windowStart: '2025-10-07T09:00:00Z',
    newsAt: '2025-10-10T09:00:00Z',
    newsNote: 'Same event and window as the Machado case',
    sources: [{ label: 'Polymarket', url: 'https://polymarket.com/event/nobel-peace-prize-winner-2025' }],
  },
  {
    id: 'ctl-us-strikes-iran-jan31',
    kind: 'control',
    title: 'US strikes Iran by January 31, 2026?',
    conditionId: '0xabb86b080e9858dcb3f46954010e49b6f539c20036856c7f999395bfd58d01e6',
    winningOutcome: 'NO',
    windowStart: '2026-01-28T00:00:00Z',
    newsAt: '2026-01-31T23:59:00Z',
    newsNote: 'Expired No',
    sources: [{ label: 'Polymarket', url: 'https://polymarket.com/event/us-strikes-iran-by' }],
  },
  {
    id: 'ctl-us-iran-ceasefire-mar31',
    kind: 'control',
    title: 'US x Iran ceasefire by March 31?',
    conditionId: '0x3c6bcb7da14ea576e5af25547dbd96f2bb24ac34e748e76aecff2ee9195dd1ac',
    winningOutcome: 'NO',
    windowStart: '2026-03-29T23:59:00Z',
    newsAt: '2026-03-31T23:59:00Z',
    newsNote: 'Expired No',
    sources: [{ label: 'Polymarket', url: 'https://polymarket.com/event/us-x-iran-ceasefire-by' }],
  },
];
