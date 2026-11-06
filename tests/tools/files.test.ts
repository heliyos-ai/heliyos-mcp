/**
 * The heliyos_files_delete, heliyos_files_get, heliyos_files_list, heliyos_files_upload tools: inputs are mapped to the Heliyos API's requests, responses to the documented output shape, and errors to actionable tool errors.
 * Runs against a mocked Heliyos API (msw); any request without a handler fails the test.
 */
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { listToolSpecs } from "../../src/index.js";
import { textOf } from "../helpers/mcp.js";
import { expectOk, expectToolError, useMockApi, type Structured } from "../helpers/harness.js";
import { acme, apiError, KEY, ok, P, RECORD_IDS, SCHEMA_IDS } from "../helpers/platform.js";

const { api, call } = useMockApi();
const FILE_ID = "69a000000000000000000001";
const ORG = "64f000000000000000000001";
const BUCKET = "heliyos-assets";
const FILE_KEY = `${ORG}/objects/company/1761123456789-notes.txt`;
const S3_URL = `https://${BUCKET}.s3.amazonaws.com/${FILE_KEY}`;
const SIGNED = `${S3_URL}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef`;
const MAX_BYTES = 10 * 1024 * 1024;

const file = {
  _id: FILE_ID,
  id: FILE_ID,
  fileName: "pricing.pdf",
  fileSize: 20480,
  mimeType: "application/pdf",
  url: `https://${BUCKET}.s3.amazonaws.com/${ORG}/1-pricing.pdf`,
  storageProvider: "S3",
  storageKey: `${ORG}/1-pricing.pdf`,
  isKbFile: false,
  description: "2026 price list",
  relationships: [{ objectId: RECORD_IDS.acme, schemaId: SCHEMA_IDS.company, objectType: "company" }],
  metadata: { created: { at: "2026-10-01T00:00:00.000Z" }, updated: { at: "2026-10-01T00:00:00.000Z" } },
};

describe("registration", () => {
  it("registers the four files tools last, in order", () => {
    const names = listToolSpecs().map((s) => s.name);
    expect(names.slice(-4)).toEqual(["heliyos_files_list", "heliyos_files_get", "heliyos_files_upload", "heliyos_files_delete"]);
  });
});

describe("heliyos_files_list", () => {
  it("filters by kind and record and returns ids", async () => {
    let url: URL | undefined;
    api.use(
      http.get(`${P}/attachments`, ({ request }) => {
        url = new URL(request.url);
        return ok([file], { pagination: { limit: 20, next_cursor: "f2" } });
      })
    );
    const result = await call("heliyos_files_list", { kind: "attachment", record_id: RECORD_IDS.acme });
    const text = expectOk(result);
    expect(url!.searchParams.get("kind")).toBe("attachment");
    expect(JSON.parse(url!.searchParams.get("filters")!)).toEqual({ objectId: RECORD_IDS.acme });
    expect(text).toContain(FILE_ID);
    expect(text).toContain("pricing.pdf");
    const sc = result.structuredContent as Structured;
    expect(sc.files[0]).toMatchObject({ id: FILE_ID, name: "pricing.pdf", kind: "attachment", size_bytes: 20480 });
    expect(sc.next_cursor).toBe("f2");
  });

  it("surfaces an API error", async () => {
    api.use(http.get(`${P}/attachments`, () => apiError(400, "VALIDATION_FAILED", "Error fetching attachments")));
    expectToolError(await call("heliyos_files_list"), "VALIDATION_FAILED");
  });
});

describe("heliyos_files_get", () => {
  it("concise returns the file without a download link", async () => {
    api.use(http.get(`${P}/attachments/${FILE_ID}`, () => ok(file)));
    const result = await call("heliyos_files_get", { file_id: FILE_ID });
    const text = expectOk(result);
    expect(text).toContain(FILE_ID);
    expect(text).toContain(RECORD_IDS.acme);
    expect((result.structuredContent as Structured).file.download_url).toBeUndefined();
  });

  it("detailed adds a download link and says it expires", async () => {
    api.use(
      http.get(`${P}/attachments/${FILE_ID}`, () => ok(file)),
      http.get(`${P}/attachments/${FILE_ID}/download`, () => ok({ url: "https://signed.example/dl?sig=1", forced: true }))
    );
    const result = await call("heliyos_files_get", { file_id: FILE_ID, response_format: "detailed" });
    const text = expectOk(result);
    expect(text).toContain("https://signed.example/dl?sig=1");
    expect(text).toMatch(/expires/i);
    expect((result.structuredContent as Structured).file.download_url).toBe("https://signed.example/dl?sig=1");
  });

  it("returns NOT_FOUND for a missing file", async () => {
    api.use(http.get(`${P}/attachments/${FILE_ID}`, () => apiError(404, "NOT_FOUND", "Attachment not found")));
    expectToolError(await call("heliyos_files_get", { file_id: FILE_ID }), "NOT_FOUND");
  });
});

describe("heliyos_files_upload", () => {
  it("presigns, PUTs the bytes without the API key, then records the file on the record", async () => {
    const order: string[] = [];
    let presignBody: any;
    let putHeaders: Headers | undefined;
    let putBody: string | undefined;
    let createBody: any;
    api.use(
      http.get(`${P}/records/${RECORD_IDS.acme}`, () => {
        order.push("record");
        return ok(acme);
      }),
      http.post(`${P}/attachments/presigned-urls`, async ({ request }) => {
        order.push("presign");
        presignBody = await request.json();
        return ok({ presignedUrl: SIGNED, fileKey: FILE_KEY, bucketName: BUCKET });
      }),
      http.put(S3_URL, async ({ request }) => {
        order.push("put");
        putHeaders = request.headers;
        putBody = await request.text();
        return new HttpResponse(null, { status: 200 });
      }),
      http.post(`${P}/attachments`, async ({ request }) => {
        order.push("create");
        createBody = await request.json();
        return ok({ ...file, _id: FILE_ID, fileName: "notes.txt", mimeType: "text/plain", fileSize: 11, isKbFile: false });
      })
    );
    const result = await call("heliyos_files_upload", {
      name: "notes.txt",
      text: "hello world",
      kind: "attachment",
      record_id: RECORD_IDS.acme,
    });
    const text = expectOk(result);
    expect(order).toEqual(["record", "presign", "put", "create"]);
    expect(presignBody).toEqual({ fileName: "notes.txt", mimeType: "text/plain; charset=utf-8", objectType: "company", fileSize: 11 });
    expect(putBody).toBe("hello world");
    expect(putHeaders!.has("authorization")).toBe(false);
    expect([...putHeaders!.values()].join(" ")).not.toContain(KEY);
    expect(putHeaders!.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(createBody).toEqual({
      fileName: "notes.txt",
      fileSize: 11,
      mimeType: "text/plain; charset=utf-8",
      url: S3_URL,
      storageProvider: "S3",
      storageKey: FILE_KEY,
      isKbFile: false,
      relationships: [{ objectId: RECORD_IDS.acme, schemaId: SCHEMA_IDS.company, objectType: "company" }],
    });
    expect(text).toContain(FILE_ID);
    expect(text).not.toContain("deadbeef");
    expect((result.structuredContent as Structured).file).toMatchObject({ id: FILE_ID, name: "notes.txt" });
  });

  it("uploads base64 content to the knowledge base", async () => {
    let createBody: any;
    let putBytes: Uint8Array | undefined;
    api.use(
      http.post(`${P}/attachments/presigned-urls`, () => ok({ presignedUrl: SIGNED, fileKey: FILE_KEY, bucketName: BUCKET })),
      http.put(S3_URL, async ({ request }) => {
        putBytes = new Uint8Array(await request.arrayBuffer());
        return new HttpResponse(null, { status: 200 });
      }),
      http.post(`${P}/attachments`, async ({ request }) => {
        createBody = await request.json();
        return ok({ ...file, isKbFile: true });
      })
    );
    const bytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const result = await call("heliyos_files_upload", {
      name: "deck.pdf",
      content_base64: Buffer.from(bytes).toString("base64"),
      kind: "knowledge_base",
    });
    expectOk(result);
    expect([...putBytes!]).toEqual([...bytes]);
    expect(createBody).toMatchObject({ fileName: "deck.pdf", fileSize: 6, mimeType: "application/pdf", isKbFile: true });
    expect(createBody.relationships).toBeUndefined();
  });

  it("sends the decoded byte length as fileSize on presign", async () => {
    let presignBody: any;
    api.use(
      http.post(`${P}/attachments/presigned-urls`, async ({ request }) => {
        presignBody = await request.json();
        return ok({ presignedUrl: SIGNED, fileKey: FILE_KEY, bucketName: BUCKET });
      }),
      http.put(S3_URL, () => new HttpResponse(null, { status: 200 })),
      http.post(`${P}/attachments`, () => ok(file))
    );
    expectOk(await call("heliyos_files_upload", { name: "deck.pdf", content_base64: "JVBERgD/", kind: "attachment" }));
    expect(presignBody).toMatchObject({ fileName: "deck.pdf", mimeType: "application/pdf", fileSize: 6 });
  });

  it("stores types the platform allows that the name implies", async () => {
    let presignBody: any;
    api.use(
      http.post(`${P}/attachments/presigned-urls`, async ({ request }) => {
        presignBody = await request.json();
        return ok({ presignedUrl: SIGNED, fileKey: FILE_KEY, bucketName: BUCKET });
      }),
      http.put(S3_URL, () => new HttpResponse(null, { status: 200 })),
      http.post(`${P}/attachments`, () => ok(file))
    );
    expectOk(await call("heliyos_files_upload", { name: "call.mp3", content_base64: "eA==", kind: "attachment" }));
    expect(presignBody.mimeType).toBe("audio/mpeg");
  });

  it.each([
    { name: "page.html", text: "<p>x</p>" },
    { name: "page.htm", text: "<p>x</p>" },
    { name: "logo.svg", text: "<svg/>" },
    { name: "feed.xml", text: "<a/>" },
    { name: "notes.txt", text: "x", content_type: "text/html" },
    { name: "a.bin", content_base64: "eA==", content_type: "image/svg+xml" },
    { name: "a.bin", content_base64: "eA==", content_type: "application/xml" },
    { name: "a.bin", content_base64: "eA==", content_type: "text/xml" },
    { name: "a.js", content_base64: "eA==", content_type: "application/javascript" },
    { name: "a.js", content_base64: "eA==", content_type: "text/javascript" },
    { name: "run.sh", content_base64: "eA==", content_type: "application/x-sh" },
    { name: "a.exe", content_base64: "eA==", content_type: "application/x-msdownload" },
  ])("refuses the content type of %j before any request", async (input) => {
    let requests = 0;
    const count = () => {
      requests += 1;
    };
    api.events.on("request:start", count);
    try {
      const text = expectToolError(await call("heliyos_files_upload", { kind: "attachment", ...input }), "VALIDATION_FAILED");
      expect(text).toContain("not an upload type Heliyos accepts");
      expect(text).toContain("images, PDF, Office and OpenDocument files");
      expect(text).toContain("application/octet-stream");
      expect(requests).toBe(0);
    } finally {
      api.events.removeListener("request:start", count);
    }
  });

  it("rejects a decoded file over 10 MB before any request", async () => {
    let requests = 0;
    const count = () => {
      requests += 1;
    };
    api.events.on("request:start", count);
    try {
      const big = Buffer.alloc(MAX_BYTES + 1, 1).toString("base64");
      const result = await call("heliyos_files_upload", { name: "big.bin", content_base64: big, kind: "attachment" });
      const text = expectToolError(result, "VALIDATION_FAILED");
      expect(text).toContain("10 MB");
      expect(requests).toBe(0);
    } finally {
      api.events.removeListener("request:start", count);
    }
  });

  it.each(["text/plain\r\nX-Evil: 1", "pdf", "text/plain; charset=utf-8"])(
    "rejects content_type %j before any request",
    async (contentType) => {
      const result = await call("heliyos_files_upload", { name: "a.txt", text: "x", kind: "attachment", content_type: contentType });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("content_type");
    }
  );

  it("says the file reached storage when recording it fails", async () => {
    api.use(
      http.post(`${P}/attachments/presigned-urls`, () => ok({ presignedUrl: SIGNED, fileKey: FILE_KEY, bucketName: BUCKET })),
      http.put(S3_URL, () => new HttpResponse(null, { status: 200 })),
      http.post(`${P}/attachments`, () => apiError(500, "INTERNAL", "Error creating attachment"))
    );
    const text = expectToolError(await call("heliyos_files_upload", { name: "a.bin", content_base64: "eA==", kind: "attachment" }), "INTERNAL");
    expect(text).toContain("reached storage");
  });

  it("rejects text over 10 MB before any request", async () => {
    const result = await call("heliyos_files_upload", { name: "big.txt", text: "a".repeat(MAX_BYTES + 1), kind: "attachment" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("10 MB");
  });

  it("needs exactly one of text and content_base64", async () => {
    expect((await call("heliyos_files_upload", { name: "a.txt", kind: "attachment" })).isError).toBe(true);
    expect((await call("heliyos_files_upload", { name: "a.txt", text: "x", content_base64: "eA==", kind: "attachment" })).isError).toBe(true);
  });

  it("rejects content_base64 that is not base64 before any request", async () => {
    const text = expectToolError(
      await call("heliyos_files_upload", { name: "a.bin", content_base64: "not base64!", kind: "attachment" }),
      "VALIDATION_FAILED"
    );
    expect(text).toContain("base64");
  });

  it("fails without recording the file when storage rejects the upload", async () => {
    api.use(
      http.post(`${P}/attachments/presigned-urls`, () => ok({ presignedUrl: SIGNED, fileKey: FILE_KEY, bucketName: BUCKET })),
      http.put(S3_URL, () => new HttpResponse("<Error/>", { status: 403 }))
    );
    const text = expectToolError(await call("heliyos_files_upload", { name: "a.txt", text: "x", kind: "attachment" }), "INTERNAL");
    expect(text).not.toContain("deadbeef");
  });

  it("returns NOT_FOUND for an unknown record before uploading", async () => {
    api.use(http.get(`${P}/records/${RECORD_IDS.globex}`, () => apiError(404, "NOT_FOUND", "Record not found")));
    const text = expectToolError(
      await call("heliyos_files_upload", { name: "a.txt", text: "x", kind: "attachment", record_id: RECORD_IDS.globex }),
      "NOT_FOUND"
    );
    expect(text).toContain(`record_id ${RECORD_IDS.globex}`);
  });
});

describe("heliyos_files_delete", () => {
  it("deletes the file", async () => {
    api.use(http.delete(`${P}/attachments/${FILE_ID}`, () => ok({})));
    const result = await call("heliyos_files_delete", { file_id: FILE_ID });
    expect(expectOk(result)).toContain(FILE_ID);
    expect(result.structuredContent).toEqual({ file_id: FILE_ID, deleted: true });
  });

  it("returns NOT_FOUND for a missing file", async () => {
    api.use(http.delete(`${P}/attachments/${FILE_ID}`, () => apiError(404, "NOT_FOUND", "Attachment not found")));
    expectToolError(await call("heliyos_files_delete", { file_id: FILE_ID }), "NOT_FOUND");
  });
});
