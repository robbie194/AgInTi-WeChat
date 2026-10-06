import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WeComApi } from "../src/wecom-api.js";

test("customer-service account preflight uses the official GET JSON request without exposing credentials", async () => {
  let requestData;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requestData = {
        method: request.method,
        pathname: new URL(request.url, "http://localhost").pathname,
        token: new URL(request.url, "http://localhost").searchParams.get("access_token"),
        contentType: request.headers["content-type"],
        body: Buffer.concat(chunks).toString("utf8"),
      };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ account_list: [{ open_kfid: "kf-test", name: "Test service" }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const api = new WeComApi({
    corpId: "corp-test",
    corpSecret: "never-print-this-api-secret",
    baseURL: `http://127.0.0.1:${port}/cgi-bin`,
    now: () => 1_000_000,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("corpid"), "corp-test");
      assert.equal(parsed.searchParams.get("corpsecret"), "never-print-this-api-secret");
      return { ok: true, json: async () => ({ access_token: "temporary-token", expires_in: 7200 }) };
    },
  });

  try {
    const result = await api.listCustomerServiceAccounts({ offset: 100, limit: 100 });
    assert.equal(result.account_list[0].open_kfid, "kf-test");
    assert.equal(requestData.method, "GET");
    assert.equal(requestData.pathname, "/cgi-bin/kf/account/list");
    assert.equal(requestData.token, "temporary-token");
    assert.equal(requestData.contentType, "application/json");
    assert.deepEqual(JSON.parse(requestData.body), { offset: 100, limit: 100 });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("customer-service account preflight retries once after an expired access token", async () => {
  let tokenCalls = 0;
  let accountCalls = 0;
  const api = new WeComApi({
    corpId: "corp-test",
    corpSecret: "test-api-secret",
    now: () => 1_000_000,
    fetchImpl: async () => {
      tokenCalls += 1;
      return { ok: true, json: async () => ({ access_token: `temporary-token-${tokenCalls}`, expires_in: 7200 }) };
    },
    fetchGetWithJsonBodyImpl: async () => {
      accountCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => accountCalls === 1
          ? { errcode: 42001, errmsg: "access_token expired" }
          : { account_list: [] },
      };
    },
  });

  await api.listCustomerServiceAccounts();
  assert.equal(tokenCalls, 2);
  assert.equal(accountCalls, 2);
});
