import { File, Paths } from 'expo-file-system';

export type DevelopedPhotoMetadata = {
  stock: string;
  focalLength: string;
  ev: number;
  developedTimestamp: string;
};

const metadataFile = new File(Paths.document, 'realor-photo-metadata.json');
let metadataWriteQueue: Promise<void> = Promise.resolve();

function isDevelopedPhotoMetadata(
  value: unknown,
): value is DevelopedPhotoMetadata {
  if (typeof value !== 'object' || value === null) return false;

  const metadata = value as Record<string, unknown>;
  return (
    typeof metadata.stock === 'string' &&
    typeof metadata.focalLength === 'string' &&
    typeof metadata.ev === 'number' &&
    Number.isFinite(metadata.ev) &&
    typeof metadata.developedTimestamp === 'string'
  );
}

async function readMetadataFile(): Promise<
  Record<string, DevelopedPhotoMetadata>
> {
  if (!metadataFile.exists) return {};

  const parsed: unknown = JSON.parse(await metadataFile.text());
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('The developed photo metadata file has an invalid format.');
  }

  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, DevelopedPhotoMetadata] =>
        isDevelopedPhotoMetadata(entry[1]),
    ),
  );
}

export async function readDevelopedPhotoMetadata(): Promise<
  Record<string, DevelopedPhotoMetadata>
> {
  await metadataWriteQueue;
  return readMetadataFile();
}

export function saveDevelopedPhotoMetadata(
  assetId: string,
  metadata: DevelopedPhotoMetadata,
): Promise<void> {
  const write = metadataWriteQueue.then(async () => {
    const current = await readMetadataFile();
    current[assetId] = metadata;

    metadataFile.create({ intermediates: true, overwrite: true });
    await metadataFile.write(JSON.stringify(current));
  });
  metadataWriteQueue = write.catch(() => undefined);
  return write;
}
