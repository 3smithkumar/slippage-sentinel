import { Hono } from "hono";
import { z } from "zod";

const app = new Hono();

// ===== Pool Depth & Slippage Simulation =====

interface PoolData {
  dex: string;
  token0: string;
  token1: string;
  reserve0: number;
  reserve1: number;
  feeBps: number;
}

interface TradeHistory {
  sizeUsd: number;
  timestamp: number;
}

// Mock pool data — in production calls DEX subgraphs/RPC
const POOLS: Record<string, PoolData> = {
  "eth-usdc-uniswap": {
    dex: "Uniswap V3",
    token0: "ETH", token1: "USDC",
    reserve0: 12500, reserve1: 42000000,
    feeBps: 5,
  },
  "eth-usdc-sushiswap": {
    dex: "SushiSwap",
    token0: "ETH", token1: "USDC",
    reserve0: 3200, reserve1: 10800000,
    feeBps: 30,
  },
  "sol-usdc-raydium": {
    dex: "Raydium",
    token0: "SOL", token1: "USDC",
    reserve0: 280000, reserve1: 42000000,
    feeBps: 25,
  },
};

// Mock trade history (last 100 trades)
const RECENT_TRADES: TradeHistory[] = Array.from({ length: 100 }, (_, i) => ({
  sizeUsd: Math.random() * 50000 + 100,
  timestamp: Date.now() - i * 60000 * (Math.random() * 2 + 0.5),
}));

function calculatePriceImpact(
  amountIn: number,
  reserveIn: number,
  reserveOut: number,
  feeBps: number
): { priceImpact: number; expectedOut: number; poolDepth: number } {
  const fee = (amountIn * feeBps) / 10000;
  const amountAfterFee = amountIn - fee;
  const newReserveIn = reserveIn + amountAfterFee;
  const newReserveOut = reserveOut;
  const amountOut = (amountAfterFee * reserveOut) / newReserveIn;
  // Price impact = (expectedOutputWithoutImpact - actualOutput) / expectedOutputWithoutImpact
  const expectedWithoutImpact = (amountIn * reserveOut) / reserveIn;
  const priceImpact = ((expectedWithoutImpact - amountOut) / expectedWithoutImpact) * 100;
  return {
    priceImpact: Math.round(priceImpact * 100) / 100,
    expectedOut: Math.round(amountOut * 100) / 100,
    poolDepth: reserveOut,
  };
}

function estimateSafeSlippage(
  pool: PoolData,
  amountIn: number,
  trades: TradeHistory[]
): {
  minSafeSlippageBps: number;
  bps95th: number;
  bps99th: number;
  depthAtImpact: Array<{ impact: number; depth: number }>;
  confidence: "low" | "medium" | "high";
} {
  // Calculate price impact at this trade size
  const impact = calculatePriceImpact(amountIn, pool.reserve0, pool.reserve1, pool.feeBps);

  // Analyze recent trade sizes
  const sortedTrades = [...trades].sort((a, b) => a.sizeUsd - b.sizeUsd);
  const p95 = sortedTrades[Math.floor(sortedTrades.length * 0.95)]?.sizeUsd || 0;
  const p99 = sortedTrades[Math.floor(sortedTrades.length * 0.99)]?.sizeUsd || 0;

  // Base slippage = price impact + pool fee + buffer
  const baseSlippageBps = impact.priceImpact * 100 + pool.feeBps;

  // If this trade is much larger than recent trades, need more slippage
  const sizeRatio = amountIn / p95;
  const sizeBuffer = sizeRatio > 2 ? Math.min((sizeRatio - 2) * 10, 100) : 0;

  // Minimum 10 bps for safety
  const recommendedBps = Math.max(Math.ceil(baseSlippageBps + sizeBuffer), 10);

  // Depth at various impact levels
  const depthLevels = [0.3, 0.5, 1, 2, 5].map(impactPct => {
    const depth = pool.reserve0 * (impactPct / 100);
    return { impact: impactPct, depth: Math.round(depth) };
  });

  // Confidence based on available data
  const confidence =
    impact.priceImpact < 0.5 && sizeRatio < 3
      ? "high"
      : impact.priceImpact < 2 && sizeRatio < 5
        ? "medium"
        : "low";

  return {
    minSafeSlippageBps: recommendedBps,
    bps95th: Math.round(p95),
    bps99th: Math.round(p99),
    depthAtImpact: depthLevels,
    confidence,
  };
}

// ===== Routes =====

app.get("/health", (c) =>
  c.json({ status: "ok", agent: "slippage-sentinel", version: "1.0.0" })
);

app.post("/estimate-slippage", async (c) => {
  try {
    const body = await c.req.json();
    const schema = z.object({
      token_in: z.string(),
      token_out: z.string(),
      amount_in: z.number().positive(),
      dex_hint: z.string().optional(),
    });
    const input = schema.parse(body);

    // Find matching pool
    const poolKey = `${input.token_in.toLowerCase()}-${input.token_out.toLowerCase()}-${(input.dex_hint || "uniswap").toLowerCase()}`;
    let pool = POOLS[poolKey];

    if (!pool) {
      // Try alternative naming
      const altKey = Object.keys(POOLS).find(
        (k) =>
          k.includes(input.token_in.toLowerCase()) &&
          k.includes(input.token_out.toLowerCase())
      );
      pool = altKey ? POOLS[altKey] : undefined;
    }

    if (!pool) {
      return c.json({ error: "Pool not found for this trading pair" }, 404);
    }

    // Determine if token_in is token0 or token1
    const isToken0 =
      pool.token0.toLowerCase() === input.token_in.toLowerCase();
    const reserveIn = isToken0 ? pool.reserve0 : pool.reserve1;
    const reserveOut = isToken0 ? pool.reserve1 : pool.reserve0;

    const result = estimateSafeSlippage(
      { ...pool, reserve0: reserveIn, reserve1: reserveOut },
      input.amount_in,
      RECENT_TRADES
    );

    return c.json({
      token_in: input.token_in,
      token_out: input.token_out,
      amount_in: input.amount_in,
      dex: pool.dex,
      fee_bps: pool.feeBps,
      ...result,
      note:
        result.confidence === "low"
          ? "Trade size significantly exceeds recent activity. Consider splitting across multiple transactions."
          : "Estimated slippage is within normal range for this pool.",
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request";
    return c.json({ error: message }, 400);
  }
});

export default app;
