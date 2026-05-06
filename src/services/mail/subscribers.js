// 구독자 관리 — 평문 JSON 저장 (.subscribers.json은 .gitignore 됨).
const fs = require("fs");
const { SUBSCRIBERS_PATH } = require("../../utils/paths");

const MAX_SUBSCRIBERS = 10;

function loadSubscribers() {
  try {
    const data = JSON.parse(fs.readFileSync(SUBSCRIBERS_PATH, "utf-8"));
    return Array.isArray(data.subscribers) ? data.subscribers : [];
  } catch (_) {
    return [];
  }
}

function saveSubscribers(list) {
  fs.writeFileSync(SUBSCRIBERS_PATH, JSON.stringify({ subscribers: list }, null, 2));
}

module.exports = { MAX_SUBSCRIBERS, loadSubscribers, saveSubscribers };
