/**
 * The one file that names the bucket vendor. S3 by default; any S3-compatible
 * store (Cloudflare R2) by `endpoint`, with its keys in the usual AWS names.
 */
import { createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import {
  POINTER,
  PointerMoved,
  SEALED,
  type SnapshotStore,
  safeProfile,
} from "../authbridge/store.js";
import { type AwsConfig, s3Aws } from "../owner.js";
import type { BlobStore } from "./ship.js";
import type { TraceStore } from "./traces.js";

export function s3BlobStore(o: { bucket: string; aws: AwsConfig; endpoint?: string }): BlobStore {
  // The SDK loads on the first put, not at every CLI start.
  const client = import("@aws-sdk/client-s3").then(({ S3Client, PutObjectCommand }) => ({
    // R2 (`endpoint`) keeps its own keys from the AWS names
    s3: new S3Client(
      o.endpoint ? { ...o.aws, region: "auto", endpoint: o.endpoint } : s3Aws(o.aws),
    ),
    PutObjectCommand,
  }));
  return {
    async put(key, body, contentType) {
      const { s3, PutObjectCommand } = await client;
      await s3.send(
        new PutObjectCommand({ Bucket: o.bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
  };
}

/** Traces, streamed (one can be hundreds of MB), in Glacier Instant Retrieval; the bucket encrypts at rest. */
export function s3TraceStore(o: { bucket: string; prefix: string; aws: AwsConfig }): TraceStore {
  const client = import("@aws-sdk/client-s3").then((sdk) => ({
    s3: new sdk.S3Client(s3Aws(o.aws)),
    ...sdk,
  }));
  return {
    where: `s3://${o.bucket}/${o.prefix}`,
    async *keys(under) {
      const { s3, ListObjectsV2Command } = await client;
      let token: string | undefined;
      do {
        const page = await s3.send(
          new ListObjectsV2Command({
            Bucket: o.bucket,
            Prefix: `${o.prefix}${under}`,
            ContinuationToken: token,
          }),
        );
        for (const c of page.Contents ?? [])
          if (c.Key) yield { key: c.Key.slice(o.prefix.length), size: c.Size ?? 0 };
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    },
    async getFile(key, path) {
      const { s3, GetObjectCommand } = await client;
      const got = await s3.send(
        new GetObjectCommand({ Bucket: o.bucket, Key: `${o.prefix}${key}` }),
      );
      if (!got.Body) throw new Error(`no body for ${key}`);
      await pipeline(got.Body as NodeJS.ReadableStream, createWriteStream(path));
    },
    async putFile(key, path) {
      // Open before the SDK call, so a file gone since the list fails as ENOENT here.
      const handle = await open(path, "r");
      const [{ s3 }, { Upload }] = await Promise.all([client, import("@aws-sdk/lib-storage")]);
      try {
        // In parts the SDK retries one by one: a stream sent whole cannot be retried, so one
        // dropped connection ended the push (2026-10-25).
        await new Upload({
          client: s3,
          params: {
            Bucket: o.bucket,
            Key: `${o.prefix}${key}`,
            Body: handle.createReadStream({ autoClose: false }),
            ContentType: "application/zip",
            StorageClass: "GLACIER_IR",
          },
        }).done();
      } finally {
        await handle.close();
      }
    },
  };
}

/**
 * The files bucket (files/store.ts `FileBucket`): put, get, list, delete under one prefix,
 * the record in `x-amz-meta-record`. Only William's own AWS user may call it (papers.tf).
 */
export function s3FileBucket(o: { bucket: string; aws: AwsConfig }) {
  const client = import("@aws-sdk/client-s3").then((sdk) => ({ s3: new sdk.S3Client(o.aws), sdk }));
  return {
    async put(key: string, data: Buffer, meta: string) {
      const { s3, sdk } = await client;
      await s3.send(
        new sdk.PutObjectCommand({
          Bucket: o.bucket,
          Key: key,
          Body: data,
          Metadata: { record: meta },
        }),
      );
    },
    async get(key: string) {
      const { s3, sdk } = await client;
      try {
        const got = await s3.send(new sdk.GetObjectCommand({ Bucket: o.bucket, Key: key }));
        const meta = got.Metadata?.record;
        if (!got.Body || !meta) return null;
        return { data: Buffer.from(await got.Body.transformToByteArray()), meta };
      } catch (err) {
        if ((err as Error).name === "NoSuchKey") return null;
        throw err;
      }
    },
    async keys(prefix: string) {
      const { s3, sdk } = await client;
      const out: string[] = [];
      let token: string | undefined;
      do {
        const page = await s3.send(
          new sdk.ListObjectsV2Command({
            Bucket: o.bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        for (const c of page.Contents ?? []) if (c.Key) out.push(c.Key);
        token = page.NextContinuationToken;
      } while (token);
      return out;
    },
    async remove(key: string) {
      const { s3, sdk } = await client;
      await s3.send(new sdk.DeleteObjectCommand({ Bucket: o.bucket, Key: key }));
    },
  };
}

type Sdk = typeof import("@aws-sdk/client-s3");

/** authbridge snapshots under `prefix` (`signins/`, an owner's `owners/<owner>/signins/`). */
export function s3SnapshotStore(o: {
  bucket: string;
  prefix: string;
  aws: AwsConfig;
}): SnapshotStore {
  let made: Promise<{ s3: import("@aws-sdk/client-s3").S3Client; sdk: Sdk }> | null = null;
  const client = () => {
    made ??= import("@aws-sdk/client-s3").then((sdk) => ({
      s3: new sdk.S3Client(s3Aws(o.aws)),
      sdk,
    }));
    return made;
  };
  const key = (profile: string, file: string) => `${o.prefix}${safeProfile(profile)}/${file}`;
  const notFound = (err: unknown) =>
    (err as { name?: string })?.name === "NoSuchKey" ||
    (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404;
  const conflict = (err: unknown) => {
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    // 412: the tag no longer matches; 409: a concurrent conditional write won
    return status === 412 || status === 409;
  };
  async function text(k: string): Promise<{ body: string; tag: string } | null> {
    const { s3, sdk } = await client();
    try {
      const got = await s3.send(new sdk.GetObjectCommand({ Bucket: o.bucket, Key: k }));
      return { body: (await got.Body?.transformToString("utf8")) ?? "", tag: got.ETag ?? "" };
    } catch (err) {
      if (notFound(err)) return null;
      throw err;
    }
  }
  async function list(prefix: string, delimiter?: string) {
    const { s3, sdk } = await client();
    const keys: string[] = [];
    const dirs: string[] = [];
    let token: string | undefined;
    do {
      const page = await s3.send(
        new sdk.ListObjectsV2Command({
          Bucket: o.bucket,
          Prefix: prefix,
          ContinuationToken: token,
          ...(delimiter ? { Delimiter: delimiter } : {}),
        }),
      );
      for (const c of page.Contents ?? []) if (c.Key) keys.push(c.Key);
      for (const p of page.CommonPrefixes ?? []) if (p.Prefix) dirs.push(p.Prefix);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return { keys, dirs };
  }
  return {
    where: `s3://${o.bucket}/${o.prefix}`,
    async putSealed(profile, version, sealed) {
      const { s3, sdk } = await client();
      await s3.send(
        new sdk.PutObjectCommand({
          Bucket: o.bucket,
          Key: key(profile, `${version}${SEALED}`),
          Body: sealed,
          ContentType: "text/plain",
          // a version is written once; a second write of the same name is a bug
          IfNoneMatch: "*",
        }),
      );
    },
    async getSealed(profile, version) {
      return (await text(key(profile, `${version}${SEALED}`)))?.body ?? null;
    },
    async versions(profile) {
      const { keys } = await list(key(profile, ""));
      return keys
        .map((k) => k.slice(k.lastIndexOf("/") + 1))
        .filter((f) => f.endsWith(SEALED))
        .map((f) => f.slice(0, -SEALED.length))
        .sort()
        .reverse();
    },
    async profiles() {
      const { dirs } = await list(o.prefix, "/");
      return dirs.map((d) => d.slice(o.prefix.length, -1));
    },
    async pointer(profile) {
      const got = await text(key(profile, POINTER));
      return got ? { value: JSON.parse(got.body), tag: got.tag } : null;
    },
    async setPointer(profile, value, tag) {
      const { s3, sdk } = await client();
      try {
        await s3.send(
          new sdk.PutObjectCommand({
            Bucket: o.bucket,
            Key: key(profile, POINTER),
            Body: JSON.stringify(value, null, 2),
            ContentType: "application/json",
            ...(tag === null ? { IfNoneMatch: "*" } : { IfMatch: tag }),
          }),
        );
      } catch (err) {
        if (conflict(err)) throw new PointerMoved(profile);
        throw err;
      }
    },
  };
}
