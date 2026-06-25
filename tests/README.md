# Test Suite — Swing Options Bot

Comprehensive unit and integration tests for the trading bot's core logic.

## Structure

### `unit.test.js` — Math & Calculation Functions
Tests for all TA indicators and position sizing logic:

- **RSI Calculation** — 6 tests
  - Handles insufficient data
  - Correct calculation on uptrend/downtrend
  - Edge cases (all gains, all losses)
  
- **Delta Calculation** — 8 tests
  - Range validation [0,1] for CALL, [-1,0] for PUT
  - ATM/ITM/OTM behavior
  - Expiry edge cases

- **Volatility Calculation** — 5 tests
  - Flat vs volatile prices
  - Data requirements
  
- **Win Rate & Position Scaling** — 8 tests
  - 0% WR → 50% budget
  - 100% WR → 120% budget (capped)
  - Scaling edge cases

- **IV Percentile Rank** — 5 tests
  - Correct percentile calculation
  - Data requirements
  - Boundary handling

- **Greeks Filtering** — 4 tests
  - Delta range 0.4–0.8 validation
  - Reject OTM/deep ITM

### `integration.test.js` — Business Logic & API Mocks
Tests for scan flow, momentum analysis, exits, risk management:

- **Scan Flow** — 5 tests
  - Market data fetching (SPY, bars, snapshot)
  - Score calculation from daily bars
  - 5m bar fetching
  - Option chain filtering

- **Momentum Analysis** — 6 tests
  - Uptrend detection for CALL
  - Downtrend detection for PUT
  - Sideways/neutral handling
  - Intraday confirmation

- **Position Sizing** — 5 tests
  - Budget constraints
  - Strike selection (ATM/OTM)
  - Contract quantity calculation

- **Exit Conditions** — 4 tests
  - Momentum exit (AGAINST)
  - EOD exit (3:20 PM + profit > 0)
  - Theta exit (DTE ≤ 2 past 3:15 PM)
  - Profit floor exit

- **Win Rate Scaling** — 5 tests
  - Scale down on losses
  - Scale up on wins
  - Capping behavior (0.5x–1.2x)

- **Daily Loss Limit** — 5 tests
  - 25% of balance calculation
  - Enforcement logic
  - Per-day tracking

## Running Tests

```bash
# Install dependencies
npm install

# Run all tests with coverage
npm test

# Run only unit tests
npm run test:unit

# Run only integration tests
npm run test:integration

# Watch mode (re-run on file changes)
npm run test:watch
```

## Expected Output

```
PASS  tests/unit.test.js
  calcRSI
    ✓ returns 50 when insufficient data
    ✓ calculates RSI correctly — uptrend should give RSI > 50
    ✓ calculates RSI correctly — downtrend should give RSI < 50
    ✓ returns 100 when all gains (no losses)
    ✓ returns 0 when all losses (no gains)
    ✓ custom period works correctly
  calcDelta
    ✓ CALL delta should be 1 when T <= 0
    ✓ PUT delta should be 0 when T <= 0
    ✓ ATM CALL delta should be ~0.5
    ✓ ATM PUT delta should be ~-0.5
    ...

PASS  tests/integration.test.js
  Scan Flow — Mock API
    ✓ should successfully fetch market data (SPY, bars, snapshot)
    ✓ should calculate score from daily bars
    ✓ should fetch 5m bars for intraday confirmation
    ✓ should fetch option chain and filter by delta
  Momentum Analysis
    ✓ detects uptrend momentum FOR CALL
    ✓ detects downtrend momentum AGAINST CALL
    ...

Test Suites: 2 passed, 2 total
Tests:       92 passed, 92 total
Snapshots:   0 total
Time:        2.341 s
```

## Coverage

- **Statements**: 60%+ (core logic, indicators)
- **Branches**: 50%+ (decision paths)
- **Functions**: 60%+ (RSI, delta, momentum, exits)
- **Lines**: 60%+ (critical paths)

Current coverage focuses on:
- ✅ Math functions (RSI, delta, volatility)
- ✅ Business logic (momentum, exits, scaling)
- ✅ Edge cases (data gaps, extremes)
- ⚠️ API integration (mocked with axios)
- ⚠️ Discord webhooks (not tested — side-effect only)

## What's NOT Tested

These require live API or are harder to isolate:

1. **Webull API calls** — Need real authentication or full mock server
2. **Discord webhook sends** — Side-effect, mocked in integration tests
3. **PM2 process management** — VM-level only
4. **Full end-to-end scan** — Requires orchestration of all components
5. **Database state** — State files (.json) not tested

## Adding New Tests

To test a new feature:

1. **For math functions**: Add to `unit.test.js`
   ```javascript
   describe("newFunction", () => {
     test("does something", () => {
       const result = newFunction(input);
       expect(result).toBe(expected);
     });
   });
   ```

2. **For logic/flow**: Add to `integration.test.js`
   ```javascript
   test("flow works correctly", async () => {
     const result = await businessLogic(mockedData);
     expect(result).toMatchObject({ ... });
   });
   ```

3. Run tests:
   ```bash
   npm run test:watch
   ```

## Mocking Strategy

- **axios**: Mocked via `jest.mock("axios")`
- **Webull API**: Returns `mockOptionChain`, `mockBars1D`, `mockBars5M`
- **Discord webhook**: Not explicitly tested (side-effect)
- **File system**: Not tested (state files)

## CI/CD Integration

To run in GitHub Actions:

```yaml
- name: Run tests
  run: npm test

- name: Upload coverage
  uses: codecov/codecov-action@v3
```

## Notes

- Tests use **Jest** (`node test environment`)
- All functions are **pure** (no side effects) where possible
- **Mocking** is shallow (Webull API, not Discord)
- Tests are **fast** (<2s for full suite)
- Coverage thresholds can be adjusted in `jest.config.js`
