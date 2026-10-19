import { File, Paths } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import { ImageFormat, type SkImage } from '@shopify/react-native-skia';

export async function saveSnapshotToLibrary(snapshot: SkImage): Promise<void> {
  let outputFile: File | undefined;

  try {
    const bytes = snapshot.encodeToBytes(ImageFormat.JPEG, 95);
    if (bytes.length === 0) {
      throw new Error('Failed to encode the filtered camera preview.');
    }

    outputFile = new File(Paths.cache, `realor-${Date.now()}.jpg`);
    outputFile.create({ intermediates: true });
    await outputFile.write(bytes);

    const permission = await MediaLibrary.requestPermissionsAsync(true, ['photo']);
    if (!permission.granted) {
      throw new Error('Photo library permission is required to save this photo.');
    }

    await MediaLibrary.Asset.create(outputFile.uri);
  } finally {
    if (outputFile?.exists) {
      outputFile.delete();
    }
  }
}
