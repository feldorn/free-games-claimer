// AliExpress mission selection and completion parsing
// Run with: node test/aliexpress-missions.js
import assert from 'node:assert/strict';
import { pickMissions, parseMissionCompletion, pickQuizUrl, pickQuizOption, parseQuizAnswer } from '../src/aliexpress-missions.js';

console.log('--- Testing AliExpress missions ---\n');

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

// Shape of a task.delivery.query material, trimmed to the fields that matter.
const material = (over = {}) => ({
  type: 0,
  taskId: 3300001,
  taskInstanceId: '920814492106',
  mainTitle: 'Browse sponsored items',
  materialUrl: 'https://m.aliexpress.com/p/coin-index/recommends.html?from=mission',
  behaviorConfig: '{"componentType":"app","time":15}',
  instanceStatus: 0,
  timesJoined: 2,
  timesLimit: 6,
  interestDetails: { '5PX4SF8J': { amount: 5, interestsType: 'coins' } },
  ...over,
});
const groups = (...materials) => materials.map(m => ({ groupId: 2458001, materials: [m] }));

test('picks an open browse mission with its dwell time', () => {
  assert.deepEqual(pickMissions(groups(material())), [
    { instanceId: '920814492106', groupId: 2458001, taskId: 3300001, title: 'Browse sponsored items', dwellSeconds: 15 },
  ]);
});

test('ignores every mission type it does not do', () => {
  // quiz/farm 30, add to cart 42, shortcut 27, share 22, widget 38, product click 26
  for (const type of [30, 42, 27, 22, 38, 26]) {
    assert.deepEqual(pickMissions(groups(material({ type }))), [], `type ${type}`);
  }
});

test('does the notifications mission, which has no URL', () => {
  const subscribe = material({ type: 43, materialUrl: '', behaviorConfig: '{}' });
  assert.equal(pickMissions(groups(subscribe)).length, 1);
});

test('does the daily check-in mission, which has no URL', () => {
  const checkin = material({ type: 15, materialUrl: '', behaviorConfig: '{}', timesJoined: 0, timesLimit: 1 });
  assert.equal(pickMissions(groups(checkin)).length, 1);
});

test('ignores missions that are finished or used up', () => {
  assert.deepEqual(pickMissions(groups(material({ instanceStatus: 2 }))), []);
  assert.deepEqual(pickMissions(groups(material({ timesJoined: 6 }))), []);
});

test('ignores missions that pay anything other than coins', () => {
  assert.deepEqual(pickMissions(groups(material({ interestDetails: undefined }))), []);
  assert.deepEqual(pickMissions(groups(material({
    interestDetails: { a: { interestsType: 'coins' }, b: { interestsType: 'coupon' } },
  }))), []);
});

test('only visits https aliexpress.com pages', () => {
  assert.equal(pickMissions(groups(material({ materialUrl: 'https://www.aliexpress.com/ssr/300003448/x' }))).length, 1);
  for (const materialUrl of ['', 'http://m.aliexpress.com/x', 'https://aliexpress.com.evil.example/x', 'https://evil.example/?aliexpress.com']) {
    assert.deepEqual(pickMissions(groups(material({ materialUrl }))), [], materialUrl);
  }
});

test('skips task ids that already failed this run', () => {
  const list = groups(material(), material({ taskId: 3298002, taskInstanceId: '920814492306' }));
  assert.deepEqual(pickMissions(list, new Set([3300001])).map(m => m.taskId), [3298002]);
});

test('dwell time falls back on a bad config and is capped', () => {
  const dwell = behaviorConfig => pickMissions(groups(material({ behaviorConfig })))[0].dwellSeconds;
  assert.equal(dwell('{"componentType":"page","time":1}'), 1);
  assert.equal(dwell('{"time":600}'), 60);
  assert.equal(dwell('{}'), 15);
  assert.equal(dwell('not json'), 15);
  assert.equal(dwell(undefined), 15);
});

test('survives a missing or malformed list', () => {
  assert.deepEqual(pickMissions(undefined), []);
  assert.deepEqual(pickMissions([{ materials: [] }, {}, null]), []);
});

test('reads the coins issued by a completed mission', () => {
  assert.deepEqual(parseMissionCompletion({
    data: { result: {
      completeSuccess: true,
      interestIssueResultMap: { 294002238106: { interestNum: 5, issueHandleResult: true } },
    } },
  }), { success: true, coins: 5 });
});

test('counts no coins that were not issued', () => {
  assert.deepEqual(parseMissionCompletion({
    data: { result: {
      completeSuccess: true,
      interestIssueResultMap: { 1: { interestNum: 5, issueHandleResult: false } },
    } },
  }), { success: true, coins: 0 });
  assert.deepEqual(parseMissionCompletion({ ret: ['FAIL_SYS_SESSION_EXPIRED::x'] }), { success: false, coins: 0 });
  assert.deepEqual(parseMissionCompletion(undefined), { success: false, coins: 0 });
});

const quiz = (over = {}) => material({
  type: 30,
  behaviorConfig: '{"taskTagId":"coinsQuestionTask","url":"https://m.aliexpress.com/p/coin-index/coinquest.html?mcms=true"}',
  timesJoined: 0,
  timesLimit: 1,
  ...over,
});

test('finds the open quiz and ignores the farm that shares its type', () => {
  const url = 'https://m.aliexpress.com/p/coin-index/coinquest.html?mcms=true';
  const farm = quiz({ behaviorConfig: '{"taskTagId":"watering2.0","url":"https://m.aliexpress.com/p/aefarm/index.html"}' });
  assert.equal(pickQuizUrl(groups(farm, quiz())), url);
  assert.equal(pickQuizUrl(groups(farm)), undefined);
  assert.equal(pickQuizUrl(undefined), undefined);
});

test('skips a quiz that is finished or points off-site', () => {
  assert.equal(pickQuizUrl(groups(quiz({ timesJoined: 1 }))), undefined);
  assert.equal(pickQuizUrl(groups(quiz({ instanceStatus: 2 }))), undefined);
  assert.equal(pickQuizUrl(groups(quiz({ behaviorConfig: '{"taskTagId":"coinsQuestionTask","url":"https://evil.example/"}' }))), undefined);
});

test('answers a new question with the last option, a known one with the saved answer', () => {
  const question = { questionId: 120001, optionList: [{ option: 'a' }, { option: 'b' }, { option: 'c' }] };
  assert.equal(pickQuizOption(question), 2);
  assert.equal(pickQuizOption(question, { 120001: 'a' }), 0);
  assert.equal(pickQuizOption(question, { 999: 'a' }), 2);
  assert.equal(pickQuizOption(question, { 120001: 'gone' }), 2);
});

test('reads the quiz result, right or wrong', () => {
  assert.deepEqual(parseQuizAnswer({ data: { success: true, data: { answerSuccess: true, correctOption: 'a', rewardInterestCount: 5 } } }),
    { answered: true, correct: true, coins: 5, correctOption: 'a' });
  assert.deepEqual(parseQuizAnswer({ data: { success: true, data: { answerSuccess: false, correctOption: 'a' } } }),
    { answered: true, correct: false, coins: 0, correctOption: 'a' });
});

test('a refused quiz answer counts as not answered', () => {
  assert.equal(parseQuizAnswer({ data: { success: false, msg: 'limit reached' } }).answered, false);
  assert.equal(parseQuizAnswer(undefined).answered, false);
});

console.log(`\n${passed} passed`);
