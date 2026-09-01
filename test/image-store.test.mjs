import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ImageStore,
  MAX_IMAGE_BYTES,
  detectImageType,
} from "../src/image-store.mjs";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function temporaryStore(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pocket-images-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ImageStore(root);
  await store.init();
  return { root, store };
}

test("image detection uses file signatures rather than claimed MIME types", () => {
  assert.deepEqual(detectImageType(PNG), { mimeType: "image/png", extension: ".png" });
  assert.deepEqual(
    detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xdb])),
    { mimeType: "image/jpeg", extension: ".jpg" },
  );
  assert.equal(detectImageType(Buffer.from("<svg onload=alert(1)>")), null);
});

test("uploaded images receive opaque URLs and resolve to localImage inputs", async (t) => {
  const { root, store } = await temporaryStore(t);
  const descriptor = await store.saveUpload(PNG, {
    fileName: encodeURIComponent("手机截图.png"),
    contentType: "image/png",
  });

  assert.match(descriptor.id, /^img_[a-f0-9]{32}$/);
  assert.equal(descriptor.src, `/api/images/${descriptor.id}`);
  assert.equal(descriptor.alt, "手机截图.png");
  assert.doesNotMatch(JSON.stringify(descriptor), new RegExp(root.replaceAll("\\", "\\\\"), "i"));

  const [input] = await store.resolveUploads([descriptor.id]);
  assert.equal(path.dirname(input.path), root);
  assert.equal(input.detail, "auto");
  const served = await store.readImage(descriptor.id);
  assert.equal(served.mimeType, "image/png");
  assert.deepEqual(served.data, PNG);
});

test("uncommitted uploads can be removed but sent images are retained", async (t) => {
  const { store } = await temporaryStore(t);
  const removable = await store.saveUpload(PNG, { fileName: "draft.png" });
  assert.equal(await store.removeUpload(removable.id), true);
  await assert.rejects(() => store.readImage(removable.id), (error) => error.status === 404);

  const committed = await store.saveUpload(PNG, { fileName: "sent.png" });
  store.commitUploads([committed.id]);
  await assert.rejects(
    () => store.removeUpload(committed.id),
    (error) => error.status === 409,
  );
});

test("thread images reuse stable opaque descriptors", async (t) => {
  const { root, store } = await temporaryStore(t);
  const localPath = path.join(root, "desktop-source.png");
  await fs.writeFile(localPath, PNG);

  const first = store.registerLocalImage(localPath, { alt: "桌面图片" });
  const second = store.registerLocalImage(localPath, { alt: "桌面图片" });
  assert.equal(first.src, second.src);
  assert.doesNotMatch(JSON.stringify(first), /desktop-source\.png/);

  const dataUrl = `data:image/png;base64,${PNG.toString("base64")}`;
  const dataFirst = store.registerDataImage(dataUrl, { alt: "生成图片" });
  const dataSecond = store.registerDataImage(dataUrl, { alt: "生成图片" });
  assert.equal(dataFirst.src, dataSecond.src);
});

test("unsupported and oversized image uploads are rejected", async (t) => {
  const { store } = await temporaryStore(t);
  await assert.rejects(
    () => store.saveUpload(Buffer.from("<svg></svg>"), { contentType: "image/svg+xml" }),
    (error) => error.status === 415,
  );
  await assert.rejects(
    () => store.saveUpload(Buffer.alloc(MAX_IMAGE_BYTES + 1), { contentType: "image/png" }),
    (error) => error.status === 413,
  );
});

test("cache pressure never evicts uploads that have not been sent", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pocket-image-pressure-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let nextId = 0;
  const store = new ImageStore(root, {
    maxEntries: 1,
    idFactory: () => (++nextId).toString(16).padStart(32, "0"),
  });
  await store.init();

  const first = await store.saveUpload(PNG, { fileName: "first.png" });
  const second = await store.saveUpload(PNG, { fileName: "second.png" });

  assert.equal(store.entries.size, 2);
  assert.equal((await store.resolveUploads([first.id, second.id])).length, 2);
});

test("pending upload limits include concurrent reservations", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pocket-image-limit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ImageStore(root, { maxPendingUploads: 1 });
  await store.init();

  const first = store.saveUpload(PNG, { fileName: "first.png" });
  await assert.rejects(
    () => store.saveUpload(PNG, { fileName: "second.png" }),
    (error) => error.status === 429 && error.code === "IMAGE_UPLOAD_LIMIT",
  );
  await first;
});
