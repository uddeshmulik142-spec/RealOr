import { useCallback, useState } from 'react';
import * as Haptics from 'expo-haptics';
import {
  FlatList,
  Image,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

export type ArchivePhoto = {
  id: string;
  uri: string;
  createdAt: Date | null;
  stock: string;
  focalLength: string;
  ev: number | null;
  developedTimestamp: string | null;
};

type ArchiveProps = {
  capturedFrames: ArchivePhoto[];
  onClose: () => void;
};

function formatExposure(exposure: number | null): string {
  if (exposure === null) return 'UNRECORDED';
  return `EV ${exposure >= 0 ? '+' : ''}${exposure.toFixed(1)}`;
}

function formatDevelopedDate(date: Date | null): string {
  if (!date || Number.isNaN(date.getTime())) {
    return 'DATE UNAVAILABLE';
  }
  const year = String(date.getFullYear()).slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year} ${month} ${day}`;
}

function formatImprintDate(date: Date | null): string {
  if (!date || Number.isNaN(date.getTime())) {
    return '-- -- --';
  }
  const year = String(date.getFullYear()).slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year} ${month} ${day}`;
}

export default function Archive({
  capturedFrames,
  onClose,
}: ArchiveProps) {
  const { width } = useWindowDimensions();
  const [selectedPhoto, setSelectedPhoto] = useState<ArchivePhoto | null>(null);

  const openPhoto = useCallback((photo: ArchivePhoto) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(
      (error: unknown) => {
        console.warn('Unable to play archive selection haptic feedback.', error);
      },
    );
    setSelectedPhoto(photo);
  }, []);

  const closeArchive = useCallback(() => {
    void Haptics.selectionAsync().catch((error: unknown) => {
      console.warn('Unable to play archive close haptic feedback.', error);
    });
    onClose();
  }, [onClose]);

  const closeLoupe = useCallback(() => {
    void Haptics.selectionAsync().catch((error: unknown) => {
      console.warn('Unable to play loupe close haptic feedback.', error);
    });
    setSelectedPhoto(null);
  }, []);

  const renderPhoto = useCallback(
    ({ item, index }: { item: ArchivePhoto; index: number }) => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open frame ${String(index + 1).padStart(2, '0')}`}
        onPress={() => openPhoto(item)}
        style={({ pressed }) => [
          styles.slideMount,
          { width: (width - 56) / 3 },
          pressed && styles.slideMountPressed,
        ]}
      >
        <Image source={{ uri: item.uri }} resizeMode="cover" style={styles.thumbnail} />
        <Text style={styles.frameNumber}>
          {String(index + 1).padStart(2, '0')}
        </Text>
        <View style={styles.marginImprint}>
          <Text style={styles.imprintDate}>
            {formatImprintDate(item.createdAt)}
          </Text>
          <Text numberOfLines={1} style={styles.imprintStock}>
            {item.stock}
          </Text>
        </View>
      </Pressable>
    ),
    [openPhoto, width],
  );

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>REAL / OR · DARKROOM</Text>
          <Text style={styles.title}>THE ARCHIVE</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close archive"
          onPress={closeArchive}
          style={({ pressed }) => [
            styles.closeButton,
            pressed && styles.buttonPressed,
          ]}
        >
          <Text style={styles.closeButtonText}>CLOSE</Text>
        </Pressable>
      </View>

      <View style={styles.contactSheet}>
        {capturedFrames.length === 0 ? (
          <View style={styles.messageState}>
            <Text style={styles.stateText}>NO DEVELOPED FRAMES YET</Text>
          </View>
        ) : (
          <FlatList
            data={capturedFrames}
            keyExtractor={(item) => item.id}
            renderItem={renderPhoto}
            numColumns={3}
            contentContainerStyle={styles.contactSheetContent}
            showsVerticalScrollIndicator={false}
            initialNumToRender={18}
            windowSize={5}
          />
        )}
      </View>
      <Text style={styles.footerLabel}>
        {String(capturedFrames.length).padStart(2, '0')} FRAMES · CONTACT SHEET
      </Text>

      {selectedPhoto ? (
        <View style={styles.loupe}>
          <View style={styles.loupeHeader}>
            <Text style={styles.eyebrow}>DARKROOM · FRAME DETAIL</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close selected photo"
              onPress={closeLoupe}
              style={({ pressed }) => [
                styles.closeButton,
                pressed && styles.buttonPressed,
              ]}
            >
              <Text style={styles.closeButtonText}>CLOSE</Text>
            </Pressable>
          </View>
          <View style={styles.loupeImageStage}>
            <Image
              source={{ uri: selectedPhoto.uri }}
              resizeMode="contain"
              style={[styles.loupeImage, { width: Math.min(width - 48, 520) }]}
            />
          </View>
          <View style={styles.metadataPlate}>
            <Text style={styles.plateTitle}>DEVELOPED FRAME</Text>
            <View style={styles.plateRule} />
            <MetadataRow label="STOCK" value={selectedPhoto.stock} />
            <MetadataRow label="LENS" value={selectedPhoto.focalLength} />
            <MetadataRow
              label="EXPOSURE"
              value={formatExposure(selectedPhoto.ev)}
            />
            <MetadataRow
              label="DEVELOPED"
              value={formatDevelopedDate(
                selectedPhoto.developedTimestamp
                  ? new Date(selectedPhoto.developedTimestamp)
                  : selectedPhoto.createdAt,
              )}
            />
            <Pressable
              accessibilityRole="button"
              onPress={closeLoupe}
              style={({ pressed }) => [
                styles.plateCloseButton,
                pressed && styles.buttonPressed,
              ]}
            >
              <Text style={styles.plateCloseText}>CLOSE FRAME</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metadataRow}>
      <Text style={styles.metadataLabel}>{label}</Text>
      <Text numberOfLines={1} style={styles.metadataValue}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#10100d',
    paddingTop: 48,
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  header: {
    minHeight: 66,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  eyebrow: {
    color: '#8e8e93',
    fontSize: 10,
    letterSpacing: 2,
    fontFamily: 'Menlo',
  },
  title: {
    color: '#e5e5ea',
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: 3,
    marginTop: 4,
  },
  closeButton: {
    minWidth: 72,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: 'center',
    backgroundColor: '#252527',
    borderColor: '#444448',
    borderWidth: 1,
    borderTopColor: '#737378',
    borderBottomWidth: 3,
    borderBottomColor: '#090909',
    borderRadius: 5,
  },
  closeButtonText: {
    color: '#e5e5ea',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  contactSheet: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#343431',
    backgroundColor: '#151512',
    padding: 6,
  },
  contactSheetContent: {
    paddingBottom: 4,
  },
  slideMount: {
    padding: 4,
    paddingBottom: 16,
    margin: 2,
    backgroundColor: '#1c1c1e',
    borderWidth: 1,
    borderColor: '#38383a',
  },
  slideMountPressed: {
    opacity: 0.78,
  },
  thumbnail: {
    width: '100%',
    aspectRatio: 3 / 4,
    backgroundColor: '#090909',
  },
  frameNumber: {
    color: '#8e8e93',
    textAlign: 'center',
    fontSize: 9,
    letterSpacing: 2,
    fontVariant: ['tabular-nums'],
    fontFamily: 'Menlo',
    paddingTop: 5,
    paddingBottom: 1,
  },
  marginImprint: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 3,
    paddingTop: 5,
  },
  imprintDate: {
    color: '#c27921',
    opacity: 0.7,
    fontSize: 6,
    letterSpacing: 0.2,
    fontFamily: 'Courier',
    fontVariant: ['tabular-nums'],
  },
  imprintStock: {
    flexShrink: 1,
    color: '#c27921',
    opacity: 0.7,
    fontSize: 6,
    letterSpacing: 0.1,
    fontFamily: 'Courier',
    textAlign: 'right',
  },
  messageState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    gap: 14,
  },
  stateText: {
    color: '#a7a7a9',
    textAlign: 'center',
    fontSize: 11,
    letterSpacing: 1.5,
    lineHeight: 18,
    fontFamily: 'Menlo',
  },
  footerLabel: {
    color: '#666663',
    fontSize: 9,
    letterSpacing: 1.5,
    fontFamily: 'Menlo',
    textAlign: 'right',
    paddingTop: 12,
  },
  loupe: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#000',
    paddingTop: 48,
    paddingHorizontal: 18,
    paddingBottom: 24,
    zIndex: 2,
  },
  loupeHeader: {
    height: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  loupeImageStage: {
    flex: 1,
    minHeight: 120,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loupeImage: {
    maxHeight: '100%',
    aspectRatio: 3 / 4,
    shadowColor: '#fff',
    shadowOpacity: 0.1,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  metadataPlate: {
    backgroundColor: '#242422',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
    borderWidth: 1,
    borderColor: '#4d4d49',
    borderTopColor: '#777772',
    borderBottomWidth: 4,
    borderBottomColor: '#111110',
    borderRadius: 6,
    shadowColor: '#000',
    shadowOpacity: 0.55,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 8,
  },
  plateTitle: {
    color: '#e5e5ea',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 2,
    fontFamily: 'Menlo',
  },
  plateRule: {
    height: 1,
    backgroundColor: '#4a4a46',
    marginVertical: 8,
  },
  metadataRow: {
    minHeight: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  metadataLabel: {
    color: '#8e8e93',
    fontSize: 9,
    letterSpacing: 1.3,
    fontFamily: 'Menlo',
  },
  metadataValue: {
    flexShrink: 1,
    color: '#ff9500',
    fontSize: 10,
    letterSpacing: 1.2,
    fontVariant: ['tabular-nums'],
    fontFamily: 'Menlo',
    textAlign: 'right',
  },
  plateCloseButton: {
    alignItems: 'center',
    marginTop: 10,
    paddingVertical: 12,
    backgroundColor: '#333330',
    borderColor: '#666660',
    borderTopWidth: 1.5,
    borderBottomColor: '#090909',
    borderBottomWidth: 4,
    borderRadius: 4,
  },
  plateCloseText: {
    color: '#e5e5ea',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 2,
  },
  buttonPressed: {
    transform: [{ translateY: 2 }],
    borderBottomWidth: 1,
  },
});
