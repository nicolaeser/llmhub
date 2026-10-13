import type { S3AddressingSetting, S3Preset, S3PresetId } from "@/types/s3";

export const S3_ADDRESSING = ["auto", "path", "virtual-hosted", "domain"] as const satisfies readonly S3AddressingSetting[];

export const S3_PRESETS: readonly S3Preset[] = [
  {
    id: "aws",
    endpoint: "https://s3.{region}.amazonaws.com",
    region: "us-east-1",
    addressing: "virtual-hosted",
    docs: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/VirtualHosting.html",
  },
  {
    id: "r2",
    endpoint: "https://{account-id}.r2.cloudflarestorage.com",
    region: "auto",
    addressing: "path",
    docs: "https://developers.cloudflare.com/r2/api/s3/api/",
  },
  {
    id: "minio",
    endpoint: "https://minio.example.com",
    region: "us-east-1",
    addressing: "path",
    docs: "https://min.io/docs/minio/linux/integrations/aws-cli-with-minio.html",
  },
  {
    id: "rustfs",
    endpoint: "http://127.0.0.1:9000",
    region: "us-east-1",
    addressing: "path",
    docs: "https://docs.rustfs.com/",
  },
  {
    id: "hetzner",
    endpoint: "https://{region}.your-objectstorage.com",
    region: "fsn1",
    addressing: "virtual-hosted",
    docs: "https://docs.hetzner.com/storage/object-storage/getting-started/using-s3-api-tools/",
  },
  {
    id: "b2",
    endpoint: "https://s3.{region}.backblazeb2.com",
    region: "us-west-004",
    addressing: "virtual-hosted",
    docs: "https://www.backblaze.com/docs/cloud-storage-s3-compatible-api",
  },
  {
    id: "wasabi",
    endpoint: "https://s3.{region}.wasabisys.com",
    region: "us-east-1",
    addressing: "path",
    docs: "https://docs.wasabi.com/docs/what-are-the-service-urls-for-wasabi-s-different-storage-regions",
  },
  {
    id: "spaces",
    endpoint: "https://{region}.digitaloceanspaces.com",
    region: "nyc3",
    addressing: "virtual-hosted",
    docs: "https://docs.digitalocean.com/products/spaces/reference/s3-compatibility/",
  },
  {
    id: "scaleway",
    endpoint: "https://s3.{region}.scw.cloud",
    region: "fr-par",
    addressing: "virtual-hosted",
    docs: "https://www.scaleway.com/en/docs/object-storage/api-cli/using-api-call-list/",
  },
  {
    id: "ionos",
    endpoint: "https://s3.{region}.ionoscloud.com",
    region: "eu-central-3",
    addressing: "path",
    docs: "https://docs.ionos.com/cloud/storage-and-backup/ionos-object-storage/endpoints",
  },
  {
    id: "custom",
    endpoint: "",
    region: "us-east-1",
    addressing: "auto",
    docs: "",
  },
];

export const S3_PRESET_IDS = S3_PRESETS.map((preset) => preset.id) as [S3PresetId, ...S3PresetId[]];

export function s3Preset(id: string): S3Preset {
  return S3_PRESETS.find((preset) => preset.id === id) ?? S3_PRESETS[S3_PRESETS.length - 1]!;
}

export function presetEndpoint(preset: S3Preset, region: string): string {
  return preset.endpoint.replaceAll("{region}", region.trim() || preset.region);
}

export function hasPlaceholder(value: string): boolean {
  return /[{}]/.test(value);
}
