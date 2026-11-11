import { createGzip } from "node:zlib";
import { piped } from "@/lib/compliance-archive/streams";
import { zipAes } from "@/lib/compliance-archive/zip-aes";
import type { ArchiveEncoding, ArchiveFormat } from "@/types/archive";

export function archiveEncoding(format: ArchiveFormat, password: string): ArchiveEncoding {
  switch (format) {
    case "zip_aes":
      return {
        format,
        extension: ".zip",
        contentType: "application/zip",
        encryption: "winzip-aes-256",
        compression: "deflate",
        encode: (lines, entry) => zipAes(lines, entry, password),
      };
    case "jsonl_gzip":
      return {
        format,
        extension: ".jsonl.gz",
        contentType: "application/gzip",
        encryption: "none",
        compression: "gzip",
        encode: (lines) => piped(lines, createGzip({ level: 6 })),
      };
    case "jsonl":
      return {
        format,
        extension: ".jsonl",
        contentType: "application/x-ndjson",
        encryption: "none",
        compression: "none",
        encode: (lines) => lines,
      };
  }
}
