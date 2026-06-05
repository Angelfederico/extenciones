function headersToObject(headers = {}) {
  if (!headers) return {};
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [String(key), String(value)]));
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [String(key), String(value)])
  );
}

function responseLike(result = {}) {
  return {
    ok: result.ok === true,
    status: Number(result.status || 0),
    statusText: String(result.statusText || ""),
    async text() {
      return String(result.text || "");
    }
  };
}

export function createPageFlowTransport({ sendPageCommand } = {}) {
  if (typeof sendPageCommand !== "function") {
    throw new Error("Page Flow transport requires sendPageCommand");
  }

  return {
    async recaptchaProvider(action, options = {}) {
      const result = await sendPageCommand({
        action: "flowRecaptcha",
        recaptchaAction: action,
        preferDirect: options.preferDirect === true || options.forceFresh === true,
        forceFresh: options.forceFresh === true,
        timeoutMs: 30000
      });
      if (!result?.ok || !result.token) {
        throw new Error(result?.error || "flow_recaptcha_failed");
      }
      return result.token;
    },

    async fetchImpl(url, init = {}) {
      const result = await sendPageCommand({
        action: "flowFetch",
        timeoutMs: 120000,
        request: {
          url: String(url || ""),
          method: String(init.method || "GET").toUpperCase(),
          mode: String(init.mode || "cors"),
          credentials: String(init.credentials || "include"),
          headers: headersToObject(init.headers),
          body: init.body === undefined ? undefined : String(init.body)
        }
      });

      if (!result?.ok && !Number(result?.status || 0)) {
        throw new Error(result?.error || "flow_fetch_failed");
      }
      return responseLike(result);
    },

    async clickDomAction(area, name, options = {}) {
      const result = await sendPageCommand({
        action: "flowDomClick",
        area: String(area || ""),
        name: String(name || ""),
        timeoutMs: Math.max(1000, Number(options.timeoutMs || 10000))
      });
      if (!result?.ok) {
        throw new Error(result?.error || "flow_dom_click_failed");
      }
      return result;
    }
  };
}
