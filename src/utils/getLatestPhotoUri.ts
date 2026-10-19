import {
  AssetField,
  MediaType,
  Query,
  requestPermissionsAsync,
} from 'expo-media-library';

export async function getLatestPhotoUri(): Promise<string | undefined> {
  const permission = await requestPermissionsAsync(false, ['photo']);
  if (!permission.granted) {
    return undefined;
  }

  const [latestPhoto] = await new Query()
    .eq(AssetField.MEDIA_TYPE, MediaType.IMAGE)
    .orderBy({ key: AssetField.CREATION_TIME, ascending: false })
    .limit(1)
    .exe();

  return latestPhoto ? await latestPhoto.getUri() : undefined;
}
