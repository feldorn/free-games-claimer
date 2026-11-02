// Pure helpers for the coin page's missions (mtop.aliexpress.interactive.task.*).
// No browser or config imports, so test/aliexpress-missions.js can run them
// against captured API payloads.

// TASK_TYPE.BROWSE in the coin page's own bundle: open a page, stay a while.
// Every other type does something to the account (add to cart, share, follow),
// only works in the app (farm, shortcut, widget) or is left out on purpose
// (PRODUCT_CLICK: bot clicks on sponsored items cost sellers).
const TASK_TYPE_BROWSE = 0;
// TASK_TYPE.SUBSCRIBE ("turn on notifications"): on the web the button just
// reports the mission as done, with no URL to visit.
const TASK_TYPE_SUBSCRIBE = 43;
// The "daily check-in" mission, separate from the check-in itself: same web
// flow as SUBSCRIBE, and finishing it puts the quiz on the list.
const TASK_TYPE_DAILY_CHECKIN = 15;
const NO_URL_TASK_TYPES = [TASK_TYPE_SUBSCRIBE, TASK_TYPE_DAILY_CHECKIN];
// TASK_TYPE.CUSTOM_BEHAVIOR_PROMOTION: the page just opens the configured URL.
// Shared by the quiz and the farm, told apart by behaviorConfig.taskTagId.
const TASK_TYPE_CUSTOM_PROMOTION = 30;
const QUIZ_TASK_TAG = 'coinsQuestionTask';
// instanceStatus: 0 = open, 2 = finished (after the last timesLimit visit).
const INSTANCE_STATUS_OPEN = 0;
const DEFAULT_DWELL_SECONDS = 15;
const MAX_DWELL_SECONDS = 60;

const isAliExpressUrl = url => {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && (hostname === 'aliexpress.com' || hostname.endsWith('.aliexpress.com'));
  } catch {
    return false;
  }
};

const paysOnlyCoins = material => {
  const rewards = Object.values(material.interestDetails || {});
  return rewards.length > 0 && rewards.every(r => r?.interestsType === 'coins');
};

const parseBehaviorConfig = behaviorConfig => {
  try {
    return JSON.parse(behaviorConfig || '{}') || {};
  } catch {
    return {};
  }
};

const dwellSeconds = behaviorConfig => {
  const time = Number(parseBehaviorConfig(behaviorConfig).time);
  return Number.isFinite(time) && time > 0 ? Math.min(time, MAX_DWELL_SECONDS) : DEFAULT_DWELL_SECONDS;
};

const isOpen = material => material.instanceStatus === INSTANCE_STATUS_OPEN && material.timesJoined < material.timesLimit;

/**
 * The missions a run may do, in page order, from task.delivery.query's
 * data.result. The page renders each group's first material only.
 *
 * @param {object[]} groups
 * @param {Set<number>} [skipTaskIds]  task ids that already failed this run.
 * @returns {{ instanceId: string, groupId: number, taskId: number, title: string, dwellSeconds: number }[]}
 */
export const pickMissions = (groups, skipTaskIds = new Set()) => {
  const materials = (Array.isArray(groups) ? groups : [])
    .filter(group => group?.materials?.[0])
    .map(group => ({ ...group.materials[0], groupId: group.groupId }));
  return materials
    .filter(m => (NO_URL_TASK_TYPES.includes(m.type) || (m.type === TASK_TYPE_BROWSE && isAliExpressUrl(m.materialUrl)))
      && isOpen(m)
      && m.taskInstanceId
      && paysOnlyCoins(m)
      && !skipTaskIds.has(m.taskId))
    .map(m => ({
      instanceId: String(m.taskInstanceId),
      groupId: m.groupId,
      taskId: m.taskId,
      title: m.mainTitle,
      dwellSeconds: dwellSeconds(m.behaviorConfig),
    }));
};

/**
 * URL of today's quiz from task.delivery.query's data.result, if it's still open.
 *
 * @param {object[]} groups
 * @returns {string | undefined}
 */
export const pickQuizUrl = groups => {
  for (const group of Array.isArray(groups) ? groups : []) {
    const material = group?.materials?.[0];
    if (material?.type !== TASK_TYPE_CUSTOM_PROMOTION || !isOpen(material)) continue;
    const { taskTagId, url } = parseBehaviorConfig(material.behaviorConfig);
    if (taskTagId === QUIZ_TASK_TAG && isAliExpressUrl(url)) return url;
  }
};

/**
 * Index of the option to answer. The API only reveals the right one after the
 * answer, so a question seen before uses the saved answer; a new one gets the
 * last option, which is "all of the above" on the questions seen so far.
 *
 * @param {{ questionId: number, optionList: { option: string }[] }} question
 * @param {Record<string, string>} [knownAnswers]  questionId → correct option.
 * @returns {number}
 */
export const pickQuizOption = (question, knownAnswers = {}) => {
  const known = question.optionList.findIndex(o => o.option === knownAnswers[question.questionId]);
  return known >= 0 ? known : question.optionList.length - 1;
};

/**
 * Result of the quiz from question.submit.answer's response.
 *
 * @param {object} response
 * @returns {{ answered: boolean, correct: boolean, coins: number, correctOption?: string }}
 */
export const parseQuizAnswer = response => {
  const answer = response?.data?.success === true ? response.data.data : null;
  return {
    answered: Boolean(answer),
    correct: answer?.answerSuccess === true,
    coins: Number(answer?.rewardInterestCount) || 0,
    correctOption: answer?.correctOption,
  };
};

/**
 * Result of a mission from task.process.complete's response.
 *
 * @param {object} response
 * @returns {{ success: boolean, coins: number }}
 */
export const parseMissionCompletion = response => {
  const result = response?.data?.result;
  const issued = Object.values(result?.interestIssueResultMap || {}).filter(r => r?.issueHandleResult === true);
  return {
    success: result?.completeSuccess === true,
    coins: issued.reduce((sum, r) => sum + (Number(r.interestNum) || 0), 0),
  };
};
