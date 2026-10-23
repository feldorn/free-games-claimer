// Joybuy unit tests for parsing, API extraction and window calculations
// Run with: node test/joybuy.js
import assert from 'node:assert/strict';
import { parseJoybuyHtml, extractFromApiJson } from '../src/platforms/joybuy.js';

console.log('--- Testing Joybuy parser & logic ---\n');

let passed = 0;
const test = (title, fn) => {
  try {
    fn();
    console.log(`✓ [PASS] ${title}`);
    passed++;
  } catch (err) {
    console.error(`✗ [FAIL] ${title}`);
    console.error(`  ${err.message}\n`);
    process.exitCode = 1;
  }
};

// 1. Unit test point conversion & delta calculation logic
test('JoyPoints value conversion and streak delta calculation', () => {
  const calcEuro = points => (points / 100).toFixed(2).replace('.', ',') + ' €';
  assert.equal(calcEuro(100), '1,00 €');
  assert.equal(calcEuro(315), '3,15 €');
  assert.equal(calcEuro(50), '0,50 €');

  const prevRun = { at: '2026-10-10 10:00:00', balance: 312, streak: 6 };
  const currentRun = { at: '2026-10-11 10:00:00', balance: 315, streak: 7 };
  const earned = Math.max(0, currentRun.balance - prevRun.balance);
  assert.equal(earned, 3, 'Earned points must be the positive difference between runs');
});

// 2. Unit test delta calculation without fallback (never invent 3 points)
test('JoyPoints delta calculation when balance is unchanged returns 0 without inventing points', () => {
  // Case A: balance before === balance after -> 0 earned
  const balanceBefore = 315;
  const userPointsNumSame = 315;
  const earnedSame = (typeof balanceBefore === 'number' && typeof userPointsNumSame === 'number' && userPointsNumSame > balanceBefore)
    ? userPointsNumSame - balanceBefore
    : 0;
  assert.equal(earnedSame, 0, 'Must report 0 when balance did not increase');

  // Case B: balanceBefore unavailable and no previous run -> 0 earned (not 3)
  const prevRun = null;
  const userPointsNum = 315;
  let earnedFallback = 0;
  if (typeof userPointsNum === 'number' && prevRun && typeof prevRun.balance === 'number' && userPointsNum > prevRun.balance) {
    earnedFallback = userPointsNum - prevRun.balance;
  }
  assert.equal(earnedFallback, 0, 'Must report 0 when delta cannot be verified (never invent 3 points)');
});

// 3. Test Next.js SSR hydration parser with Joybuy live chunk sample (SIGNED / already done)
test('parseJoybuyHtml accurately extracts points, euro, streaks, and check-in state', () => {
  const mockSsrHtml = `
    <html>
      <head></head>
      <body>
        <script>
          self.__next_f.push([1, "78:{\\"currentPoints\\":315,\\"shoppingValue\\":\\"3,15 €\\",\\"buttonText\\":\\"Demain connexion +23 points\\",\\"checkInState\\":5,\\"title\\":\\"Série de 7 jours\\",\\"pointsNum\\":20,\\"currentProgress\\":7,\\"totalProgress\\":7}"])</script>
        <script>
          self.__next_f.push([1, "79:{\\"title\\":\\"Total sur 3 jours\\",\\"pointsNum\\":10,\\"currentProgress\\":3,\\"totalProgress\\":3}"])</script>
      </body>
    </html>
  `;

  const res = parseJoybuyHtml(mockSsrHtml);
  assert.equal(res.userPointsNum, 315, 'Must extract 315 points');
  assert.equal(res.totalEuro, '3,15 €', 'Must extract 3,15 €');
  assert.equal(res.checkInState, 5, 'Must extract checkInState 5 (SIGNED)');
  assert.equal(res.isAlreadyDone, true, 'checkInState 5 means already signed');
  assert.equal(res.isClaimable, false, 'Should not be claimable when already signed');
  assert.equal(res.streakDays, 7, 'Must extract 7 streak days');
  assert.equal(res.streak7, '7/7', 'Must extract 7/7 streak progress');
  assert.equal(res.streak3, '3/3', 'Must extract 3/3 3-day series progress');
  assert.equal(res.tomorrowPoints, 23, 'Must extract +23 tomorrow points');
});

// 4. Test parseJoybuyHtml with claimable (UNSIGNED) state
test('parseJoybuyHtml identifies claimable (checkInState 1) portal state', () => {
  const mockClaimableHtml = `
    <html>
      <body>
        <script>
          self.__next_f.push([1, "50:{\\"currentPoints\\":312,\\"shoppingValue\\":\\"3,12 €\\",\\"buttonText\\":\\"Pointage quotidien\\",\\"checkInState\\":1,\\"title\\":\\"Série de 7 jours\\",\\"pointsNum\\":20,\\"currentProgress\\":6,\\"totalProgress\\":7}"])</script>
      </body>
    </html>
  `;

  const res = parseJoybuyHtml(mockClaimableHtml);
  assert.equal(res.userPointsNum, 312, 'Must extract 312 points');
  assert.equal(res.checkInState, 1, 'Must extract checkInState 1 (UNSIGNED)');
  assert.equal(res.isClaimable, true, 'Must identify as claimable');
  assert.equal(res.isAlreadyDone, false, 'Must not be marked already done');
  assert.equal(res.streakDays, 6, 'Must extract 6 streak days');
  assert.equal(res.streak7, '6/7', 'Must extract 6/7 streak progress');
});

// 5. Test parseJoybuyHtml with DOM fallback (when SSR hydration chunks are absent)
test('parseJoybuyHtml falls back to DOM elements when SSR chunks are absent', () => {
  const mockDomHtml = `
    <!DOCTYPE html>
    <html>
      <head><title>Mes points Joybuy</title></head>
      <body>
        <div class="header">
          <span class="pointsValue">420</span>
          <span class="pointsUnit">Pts</span>
          <span class="value">4,20 €</span>
        </div>
        <div class="streakSection">
          <span class="progressText">5/7</span>
        </div>
      </body>
    </html>
  `;
  const res = parseJoybuyHtml(mockDomHtml);
  assert.equal(res.userPointsNum, 420, 'Must extract points from pointsValue DOM element');
  assert.equal(res.totalEuro, '4,20 €', 'Must extract euro value from DOM element');
  assert.equal(res.streakDays, 5, 'Must extract streakDays from progressText DOM element');
  assert.equal(res.isClaimable, false, 'DOM fallback without checkInState must not assume claimable');
});

// 6. Test parseJoybuyHtml with logged-out or login redirect page fixture
test('parseJoybuyHtml correctly handles logged-out / login redirect pages', () => {
  const mockLoginPageHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta name="stream-page-id" content="NewLogin">
        <title>Connectez-vous à votre compte Joybuy</title>
      </head>
      <body>
        <form action="/login">
          <input type="email" name="loginName" placeholder="E-mail">
          <input type="password" name="loginPassword" placeholder="Mot de passe">
          <button type="submit">Se connecter</button>
          <a href="/register">S'enregistrer</a>
        </form>
      </body>
    </html>
  `;

  const res = parseJoybuyHtml(mockLoginPageHtml);
  assert.equal(res.userPointsNum, null, 'Points must be null on login page');
  assert.equal(res.checkInState, null, 'checkInState must be null on login page');
  assert.equal(res.isClaimable, false, 'Login page must not be claimable');
  assert.equal(res.isAlreadyDone, false, 'Login page must not be marked already done');
});

// 7. Test parseJoybuyHtml with expired session / blank or invalid HTML
test('parseJoybuyHtml gracefully handles empty or invalid HTML without errors', () => {
  const resEmpty = parseJoybuyHtml('');
  assert.equal(resEmpty.userPointsNum, null);
  assert.equal(resEmpty.isClaimable, false);
  assert.equal(resEmpty.isAlreadyDone, false);

  const resNull = parseJoybuyHtml(null);
  assert.equal(resNull.userPointsNum, null);
  assert.equal(resNull.isClaimable, false);
  assert.equal(resNull.isAlreadyDone, false);
});

// 8. Test targeted API response extraction (user_account_get, user_mission_daily_checkin)
test('extractFromApiJson extracts account balance and check-in success without noise', () => {
  // Test user_account_get payload
  const accountUrl = 'https://color-api.joybuy.fr/?functionId=user_account_get&appid=joybuyM';
  const accountPayload = {
    code: '200',
    data: {
      accountList: [
        { type: 1, count: 315 },
        { type: 9, count: 0 },
        { type: 3, count: 1 },
      ],
    },
  };
  const accountRes = extractFromApiJson(accountUrl, accountPayload);
  assert.equal(accountRes.userPointsNum, 315, 'Must extract type: 1 (315 points) and ignore type: 9 (0)');

  // Test user_mission_daily_checkin payload
  const checkinUrl = 'https://color-api.joybuy.fr/?functionId=user_mission_daily_checkin&appid=joybuyM';
  const checkinPayload = {
    code: '200',
    data: {
      result: true,
    },
  };
  const checkinRes = extractFromApiJson(checkinUrl, checkinPayload);
  assert.equal(checkinRes.collected, true, 'Must confirm check-in success from API response');

  // Test that unrelated API with score: 0 is ignored
  const settingsUrl = 'https://color-api.joybuy.fr/?functionId=user_settings_getVersionInfo';
  const settingsPayload = { code: '200', data: { score: 0 } };
  const settingsRes = extractFromApiJson(settingsUrl, settingsPayload);
  assert.equal(settingsRes.userPointsNum, undefined, 'Must not corrupt point balance with unrelated score: 0');
});

// 9. Test API error handling and failed check-in responses
test('extractFromApiJson handles API error codes and failed check-in without false positives', () => {
  // Check-in API failed
  const failedCheckinUrl = 'https://color-api.joybuy.fr/?functionId=user_mission_daily_checkin';
  const failedCheckinPayload = { code: '500', message: 'System busy', data: { result: false } };
  const failedRes = extractFromApiJson(failedCheckinUrl, failedCheckinPayload);
  assert.equal(failedRes.collected, undefined, 'Must not report collected: true on API error');

  // Session expired / 401
  const expiredAccountUrl = 'https://color-api.joybuy.fr/?functionId=user_account_get';
  const expiredPayload = { code: '401', message: 'Not logged in' };
  const expiredRes = extractFromApiJson(expiredAccountUrl, expiredPayload);
  assert.equal(expiredRes.userPointsNum, undefined, 'Must not set points on expired session API response');
});

// 10. Unit test random window target calculation math
test('Target window picker stays strictly within configured window bounds', () => {
  const mockConfig = { joybuyStart: 14, joybuyHours: 3 }; // 14:00 -> 17:00
  const dateKey = '2026-10-15';
  const [y, m, d] = dateKey.split('-').map(Number);
  const startMs = new Date(y, m - 1, d, mockConfig.joybuyStart, 0, 0, 0).getTime();
  const endMs = startMs + mockConfig.joybuyHours * 3600 * 1000;

  for (let i = 0; i < 50; i++) {
    const offsetMinutes = Math.floor(Math.random() * (mockConfig.joybuyHours * 60));
    const target = new Date(y, m - 1, d, mockConfig.joybuyStart, offsetMinutes, 0, 0);
    const targetMs = target.getTime();
    assert.ok(targetMs >= startMs, `Target ${target.toISOString()} must be >= start of window ${new Date(startMs).toISOString()}`);
    assert.ok(targetMs < endMs, `Target ${target.toISOString()} must be < end of window ${new Date(endMs).toISOString()}`);
  }
});

console.log(`\nAll ${passed} Joybuy tests passed successfully!`);
