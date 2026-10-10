import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WeComApi } from "../src/wecom-api.js";

test("customer-service account preflight uses the official POST JSON request without exposing credentials", async () => {
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
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/gettoken")) {
        assert.equal(parsed.searchParams.get("corpid"), "corp-test");
        assert.equal(parsed.searchParams.get("corpsecret"), "never-print-this-api-secret");
        return { ok: true, json: async () => ({ access_token: "temporary-token", expires_in: 7200 }) };
      }
      return fetch(url, options);
    },
  });

  try {
    const result = await api.listCustomerServiceAccounts({ offset: 100, limit: 100 });
    assert.equal(result.account_list[0].open_kfid, "kf-test");
    assert.equal(requestData.method, "POST");
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
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/gettoken")) {
        tokenCalls += 1;
        return { ok: true, json: async () => ({ access_token: `temporary-token-${tokenCalls}`, expires_in: 7200 }) };
      }
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

test("customer-service file downloads use the configured API base URL", async () => {
  const requests = [];
  const api = new WeComApi({
    corpId: "corp-test",
    corpSecret: "test-api-secret",
    baseURL: "https://wecom-proxy.example/cgi-bin",
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (new URL(url).pathname.endsWith("/gettoken")) {
        return new Response(JSON.stringify({ access_token: "temporary-token", expires_in: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(Buffer.from("file-bytes"), {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": "attachment; filename=report.pdf",
        },
      });
    },
  });

  const result = await api.downloadCustomerServiceFile("file-id", 1024);
  assert.equal(result.buffer.toString(), "file-bytes");
  assert.equal(result.contentType, "application/pdf");
  assert.equal(result.filename, "report.pdf");
  const fileRequest = requests.at(-1);
  assert.equal(fileRequest.url, "https://wecom-proxy.example/cgi-bin/kf/get_msg_file?access_token=temporary-token");
  assert.equal(fileRequest.options.method, "POST");
  assert.deepEqual(JSON.parse(fileRequest.options.body), { file_id: "file-id" });
});

test("customer-service media is uploaded and sent as a native WeChat message", async () => {
  const requests = [];
  const api = new WeComApi({
    corpId: "corp-test",
    corpSecret: "test-api-secret",
    baseURL: "https://wecom-proxy.example/cgi-bin",
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/gettoken")) return new Response(JSON.stringify({ access_token: "temporary-token", expires_in: 7200 }), { status: 200 });
      if (pathname.endsWith("/media/upload")) return new Response(JSON.stringify({ media_id: "media-image" }), { status: 200 });
      return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
    },
  });

  const mediaId = await api.uploadMedia(Buffer.from("image-bytes"), { type: "image", filename: "plot.png" });
  await api.sendMedia("kf-test", "external-test", "image", mediaId, "message-id");
  assert.equal(mediaId, "media-image");
  assert.equal(new URL(requests[1].url).pathname, "/cgi-bin/media/upload");
  assert.equal(requests[1].options.method, "POST");
  assert.ok(requests[1].options.body instanceof FormData);
  assert.equal(new URL(requests[2].url).pathname, "/cgi-bin/kf/send_msg");
  assert.deepEqual(JSON.parse(requests[2].options.body), {
    touser: "external-test",
    open_kfid: "kf-test",
    msgid: "message-id",
    msgtype: "image",
    image: { media_id: "media-image" },
  });
});
