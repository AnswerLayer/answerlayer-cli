export class AnswerLayerApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "AnswerLayerApiError";
    this.status = status;
    this.body = body;
  }
}

export class AnswerLayerClient {
  constructor({ baseUrl, apiKey, fetchImpl = globalThis.fetch }) {
    if (!baseUrl) {
      throw new Error("Missing API base URL. Pass `--base-url <url>`, run `answerlayer configure --base-url <url> --api-key <key>`, or set ANSWERLAYER_BASE_URL.");
    }

    if (!fetchImpl) {
      throw new Error("This CLI requires Node.js 20+ with global fetch support.");
    }

    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async request(method, path, { body, query, auth = true } = {}) {
    const result = await this.rawRequest(method, path, {
      body,
      query,
      auth,
      headers: { Accept: "application/json" },
    });
    return result.data;
  }

  async rawRequest(method, path, { body, query, headers = {}, auth = true } = {}) {
    if (auth && !this.apiKey) {
      throw new Error("Missing API key. Run `answerlayer configure --base-url <url> --api-key <key>` or set ANSWERLAYER_API_KEY.");
    }

    const apiPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${apiPath}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item !== undefined && item !== null && item !== "") {
              url.searchParams.append(key, String(item));
            }
          }
        } else if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const requestHeaders = {
      Accept: "application/json",
      "User-Agent": "answerlayer-cli/0.1.0",
      ...headers,
    };

    if (auth) {
      requestHeaders["X-API-Key"] = this.apiKey;
    }

    const init = { method, headers: requestHeaders };
    if (body !== undefined) {
      if (isFormData(body) || typeof body === "string" || Buffer.isBuffer(body)) {
        init.body = body;
      } else {
        requestHeaders["Content-Type"] = requestHeaders["Content-Type"] || "application/json";
        init.body = JSON.stringify(body);
      }
    }

    const response = await this.fetchImpl(url, init);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const text = buffer.toString("utf8");
    const responseHeaders = Object.fromEntries(response.headers.entries());
    const contentType = response.headers.get("content-type") || "";
    const data = parseResponseBody(text, contentType);

    if (!response.ok) {
      const detail = data && typeof data === "object" && "detail" in data
        ? data.detail
        : text;
      const message = detail
        ? `API request failed (${response.status}): ${formatDetail(detail)}`
        : `API request failed (${response.status})`;
      throw new AnswerLayerApiError(message, { status: response.status, body: data });
    }

    return {
      status: response.status,
      headers: responseHeaders,
      contentType,
      buffer,
      text,
      data,
    };
  }

  health() {
    return this.request("GET", "/api/v1/health", { auth: false });
  }

  listConnections() {
    return this.request("GET", "/api/v1/connections/");
  }

  getConnection(id) {
    return this.request("GET", `/api/v1/connections/${encodeURIComponent(id)}`);
  }

  runQuery(connectionId, payload) {
    return this.request("POST", `/api/v1/query/${encodeURIComponent(connectionId)}`, {
      body: payload,
    });
  }

  validateQuery(connectionId, payload) {
    return this.request("POST", `/api/v1/query/${encodeURIComponent(connectionId)}/validate`, {
      body: payload,
    });
  }

  listSavedQueries() {
    return this.request("GET", "/api/v1/saved-queries");
  }

  getSavedQuery(id) {
    return this.request("GET", `/api/v1/saved-queries/${encodeURIComponent(id)}`);
  }

  createSavedQuery(payload) {
    return this.request("POST", "/api/v1/saved-queries", { body: payload });
  }

  executeSavedQuery(id, payload) {
    return this.request("POST", `/api/v1/saved-queries/${encodeURIComponent(id)}/execute`, {
      body: payload,
    });
  }

  createInquirySession(payload) {
    return this.request("POST", "/api/v1/inquiry/sessions", { body: payload });
  }

  runInquiryTurnSync(sessionId, payload) {
    return this.request("POST", `/api/v1/inquiry/sessions/${encodeURIComponent(sessionId)}/sync`, {
      body: payload,
    });
  }
}

function parseResponseBody(text, contentType) {
  if (!text) {
    return null;
  }

  if (contentType && contentType.includes("application/json")) {
    return JSON.parse(text);
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatDetail(detail) {
  if (typeof detail === "string") {
    return detail;
  }
  return JSON.stringify(detail);
}

function isFormData(value) {
  return typeof FormData !== "undefined" && value instanceof FormData;
}
