function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// KIS API 초당 호출 제한(EGW00201) 대응 — 호출 전 sleep + EGW00201 지수 백오프 재시도.
async function safeApiCall(fn, delayMs = 1000, retries = 3) {
  await sleep(delayMs);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err?.message || "";
      const respMsg = err?.response?.data?.msg_cd || "";
      const isRateLimit = /EGW00201|초당/.test(msg) || respMsg === "EGW00201";
      if (!isRateLimit || attempt === retries) {
        throw err;
      }
      const backoff = 1500 * Math.pow(2, attempt);
      console.warn(`[KIS] rate limited (EGW00201), backoff ${backoff}ms then retry ${attempt + 1}/${retries}`);
      await sleep(backoff);
    }
  }
}

module.exports = { sleep, safeApiCall };
