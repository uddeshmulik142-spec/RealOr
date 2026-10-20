import { useCallback, useEffect, useRef, useState } from 'react';
import Animated, {
  interpolateColor,
  useDerivedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import {
  Asset,
  AssetField,
  MediaType,
  Query,
  requestPermissionsAsync,
} from 'expo-media-library';
import * as Haptics from 'expo-haptics';
import {
  AppState,
  FlatList,
  Image,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import * as Crypto from 'expo-crypto';
import {
  getIpAddressAsync,
  getNetworkStateAsync,
  NetworkStateType,
} from 'expo-network';
import type { HttpServer } from 'react-native-nitro-http-server';
import { readDevelopedPhotoMetadata } from '../utils/photoMetadata';
import {
  startScanningStationServer,
  type ScanningStationPhoto,
} from '../utils/scanningStationServer';

type ArchivePhoto = {
  id: string;
  uri: string;
  createdAt: Date | null;
  stock: string;
  focalLength: string;
  ev: number | null;
  developedTimestamp: string | null;
};

type ArchiveProps = {
  onClose: () => void;
};

const PHOTO_LIMIT = 300;

async function loadArchivePhotos(): Promise<ArchivePhoto[] | null> {
  const permission = await requestPermissionsAsync(false, ['photo']);
  if (!permission.granted) {
    return null;
  }

  const assets: Asset[] = await new Query()
    .eq(AssetField.MEDIA_TYPE, MediaType.IMAGE)
    .orderBy({ key: AssetField.CREATION_TIME, ascending: false })
    .limit(PHOTO_LIMIT)
    .exe();

  const [metadataById, loadedAssets] = await Promise.all([
    readDevelopedPhotoMetadata(),
    Promise.all(
      assets.map(async (asset) => {
        const [uri, creationTime] = await Promise.all([
          asset.getUri(),
          asset.getCreationTime(),
        ]);
        return {
          id: asset.id,
          uri,
          createdAt:
            creationTime === null ? null : new Date(creationTime * 1000),
          creationTime,
        };
      }),
    ),
  ]);

  return loadedAssets.map((asset) => {
    const metadata = metadataById[asset.id];
    return {
      id: asset.id,
      uri: asset.uri,
      createdAt: asset.createdAt,
      stock: metadata?.stock ?? 'UNRECORDED',
      focalLength: metadata?.focalLength ?? 'UNRECORDED',
      ev: metadata?.ev ?? null,
      developedTimestamp:
        metadata?.developedTimestamp ??
        (asset.creationTime === null
          ? null
          : new Date(asset.creationTime * 1000).toISOString()),
    };
  });
}

async function loadDevelopedPhotosForStation(): Promise<
  ScanningStationPhoto[]
> {
  const metadata = await readDevelopedPhotoMetadata();
  const entries = Object.entries(metadata);
  const stationPhotos: ScanningStationPhoto[] = [];

  for (let start = 0; start < entries.length; start += 10) {
    const batch = await Promise.all(
      entries
        .slice(start, start + 10)
        .map(async ([id, details]): Promise<ScanningStationPhoto | null> => {
          try {
            const asset = new Asset(id);
            const uri = await asset.getUri();
            return {
              id,
              uri,
              stock: details.stock,
              focalLength: details.focalLength,
              ev: details.ev,
              developedTimestamp: details.developedTimestamp,
            };
          } catch (error) {
            console.warn(
              'A developed frame could not be resolved for the scanning station.',
              error,
            );
            return null;
          }
        }),
    );

    stationPhotos.push(
      ...batch.filter(
        (photo): photo is ScanningStationPhoto => photo !== null,
      ),
    );
  }

  return stationPhotos;
}

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
  onClose,
}: ArchiveProps) {
  const { width } = useWindowDimensions();
  const [photos, setPhotos] = useState<ArchivePhoto[]>([]);
  const [selectedPhoto, setSelectedPhoto] = useState<ArchivePhoto | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stationVisible, setStationVisible] = useState(false);
  const [stationCode, setStationCode] = useState<string | null>(null);
  const [stationIp, setStationIp] = useState<string | null>(null);
  const [stationPort, setStationPort] = useState<number | null>(null);
  const [stationRunning, setStationRunning] = useState(false);
  const [stationError, setStationError] = useState<string | null>(null);
  const [transferRate, setTransferRate] = useState(0);
  const [appIsActive, setAppIsActive] = useState(
    AppState.currentState === 'active',
  );
  const bytesServed = useRef(0);
  const previousBytesServed = useRef(0);
  const safelightProgress = useDerivedValue(() =>
    isLoading
      ? withRepeat(withTiming(1, { duration: 1400 }), -1, true)
      : withTiming(0, { duration: 300 }),
  );
  const safelightStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      safelightProgress.value,
      [0, 1],
      ['#050505', '#3a0505'],
    ),
  }));
  const stationLedProgress = useDerivedValue(() =>
    stationRunning
      ? withRepeat(withTiming(1, { duration: 850 }), -1, true)
      : withTiming(0.25, { duration: 250 }),
  );
  const stationLedStyle = useAnimatedStyle(() => ({
    opacity: stationLedProgress.value,
  }));

  const refreshPhotos = useCallback(async () => {
    setIsLoading(true);
    setPermissionDenied(false);
    setLoadError(null);
    try {
      const loadedPhotos = await loadArchivePhotos();
      if (loadedPhotos === null) {
        setPermissionDenied(true);
      } else {
        setPhotos(loadedPhotos);
      }
    } catch (error) {
      console.error('Unable to load photos for the archive.', error);
      setLoadError('The photo archive could not be loaded.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const loadTimeout = setTimeout(() => {
      void refreshPhotos();
    }, 0);
    return () => clearTimeout(loadTimeout);
  }, [refreshPhotos]);

  const generateStationCode = useCallback(async () => {
    try {
      const bytes = await Crypto.getRandomBytesAsync(16);
      setStationCode(
        Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''),
      );
      setStationError(null);
    } catch (error) {
      console.error('Unable to generate a scanning station access code.', error);
      setStationError('A secure session code could not be generated.');
    }
  }, []);

  const openStation = useCallback(() => {
    setStationVisible(true);
    setStationIp(null);
    setStationPort(null);
    setStationError(null);
    bytesServed.current = 0;
    previousBytesServed.current = 0;
    setTransferRate(0);
    void generateStationCode();
  }, [generateStationCode]);

  const closeStation = useCallback(() => {
    setStationVisible(false);
    setStationCode(null);
    setStationRunning(false);
    setStationPort(null);
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      const active = state === 'active';
      setAppIsActive(active);
      if (!active) {
        setStationRunning(false);
        setTransferRate(0);
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!stationVisible || !stationCode || !appIsActive) return;

    let cancelled = false;
    let localServer: HttpServer | null = null;

    const startServer = async () => {
      try {
        const [network, ip] = await Promise.all([
          getNetworkStateAsync(),
          getIpAddressAsync(),
        ]);
        if (cancelled) return;
        setStationIp(ip);
        if (network.type !== NetworkStateType.WIFI || ip === '0.0.0.0') {
          throw new Error(
            'Connect Real / Or to Wi-Fi before starting the scanning station.',
          );
        }

        const stationPhotos = await loadDevelopedPhotosForStation();
        if (cancelled) return;
        const result = await startScanningStationServer(
          stationPhotos,
          stationCode,
          (byteCount) => {
            bytesServed.current += byteCount;
          },
          ip,
        );
        localServer = result.server;
        if (cancelled) {
          await result.server.stop();
          return;
        }
        setStationPort(result.port);
        setStationRunning(true);
      } catch (error) {
        console.error('Unable to start the local scanning station.', error);
        if (!cancelled) {
          setStationError(
            error instanceof Error
              ? error.message
              : 'The local scanning station could not be started.',
          );
        }
      }
    };
    void startServer();

    return () => {
      cancelled = true;
      if (localServer) {
        void localServer.stop().catch((error: unknown) => {
          console.error('Unable to stop the local scanning station.', error);
        });
      }
    };
  }, [appIsActive, stationCode, stationVisible]);

  useEffect(() => {
    if (!stationVisible || !stationRunning) return;

    previousBytesServed.current = bytesServed.current;
    const rateTimer = setInterval(() => {
      const delta = bytesServed.current - previousBytesServed.current;
      previousBytesServed.current = bytesServed.current;
      setTransferRate(delta / (1024 * 1024));
    }, 1000);
    return () => clearInterval(rateTimer);
  }, [stationRunning, stationVisible]);

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
    <Animated.View style={[styles.container, safelightStyle]}>
      <StatusBar barStyle="light-content" />
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>REAL / OR · DARKROOM</Text>
          <Text style={styles.title}>THE ARCHIVE</Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open scanning station"
            onPress={openStation}
            style={({ pressed }) => [
              styles.stationLaunchButton,
              pressed && styles.buttonPressed,
            ]}
          >
            <Text style={styles.stationLaunchText}>SCANNING STATION</Text>
          </Pressable>
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
      </View>

      <View
        style={[
          styles.contactSheet,
          isLoading && styles.contactSheetLoading,
        ]}
      >
        {isLoading ? (
          <View style={styles.messageState}>
            <View style={styles.safelightIndicator} />
            <Text style={styles.stateText}>DEVELOPING CONTACT SHEET</Text>
          </View>
        ) : permissionDenied ? (
          <View style={styles.messageState}>
            <Text style={styles.stateText}>
              PHOTO LIBRARY ACCESS IS REQUIRED TO VIEW THE ARCHIVE
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => void refreshPhotos()}
              style={styles.retryButton}
            >
              <Text style={styles.retryButtonText}>TRY AGAIN</Text>
            </Pressable>
          </View>
        ) : loadError ? (
          <View style={styles.messageState}>
            <Text style={styles.stateText}>{loadError}</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => void refreshPhotos()}
              style={styles.retryButton}
            >
              <Text style={styles.retryButtonText}>RETRY</Text>
            </Pressable>
          </View>
        ) : photos.length === 0 ? (
          <View style={styles.messageState}>
            <Text style={styles.stateText}>NO DEVELOPED FRAMES YET</Text>
          </View>
        ) : (
          <FlatList
            data={photos}
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
        {String(photos.length).padStart(2, '0')} FRAMES · CONTACT SHEET
      </Text>

      {stationVisible ? (
        <View style={styles.stationOverlay}>
          <View style={styles.stationPanel}>
            <View style={styles.stationPanelHeader}>
              <View>
                <Text style={styles.eyebrow}>LOCAL DARKROOM LINK</Text>
                <Text style={styles.stationTitle}>SCANNING STATION</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close scanning station"
                onPress={closeStation}
                style={styles.closeButton}
              >
                <Text style={styles.closeButtonText}>CLOSE</Text>
              </Pressable>
            </View>
            <View style={styles.stationStatusRow}>
              <Animated.View
                style={[
                  styles.stationLed,
                  stationRunning && styles.stationLedActive,
                  stationLedStyle,
                ]}
              />
              <Text style={styles.stationStatus}>
                {stationError
                  ? 'LOCAL TRANSMITTER UNAVAILABLE'
                  : stationRunning
                  ? 'LOCAL TRANSMITTER ACTIVE'
                  : appIsActive
                    ? 'STARTING LOCAL TRANSMITTER'
                    : 'TRANSMITTER PAUSED · APP IN BACKGROUND'}
              </Text>
            </View>
            <Text style={styles.stationReadoutLabel}>DESKTOP URL</Text>
            <Text selectable style={styles.stationReadout}>
              {stationRunning && stationIp && stationIp !== '0.0.0.0'
                ? `http://${stationIp}:${stationPort}`
                : 'Connect this device to Wi-Fi to resolve its address'}
            </Text>
            <Text style={styles.stationReadoutLabel}>SESSION ACCESS CODE</Text>
            <Text selectable style={styles.stationCode}>
              {stationCode ?? 'GENERATING SECURE CODE…'}
            </Text>
            <View style={styles.transferReadout}>
              <Text style={styles.stationReadoutLabel}>OUTBOUND TRANSFER</Text>
              <Text style={styles.transferRate}>
                {transferRate.toFixed(2)} MB / SEC
              </Text>
            </View>
            {stationError ? (
              <Text accessibilityRole="alert" style={styles.stationError}>
                {stationError}
              </Text>
            ) : null}
            <Text style={styles.stationHint}>
              Enter the URL on a device connected to the same trusted Wi-Fi
              network, then unlock with this session code. The transmitter
              stops when closed or when Real / Or enters the background. Only
              Real / Or captures with saved metadata are shared.
            </Text>
            {stationError ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => void generateStationCode()}
                style={styles.retryButton}
              >
                <Text style={styles.retryButtonText}>RETRY SESSION</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}

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
    </Animated.View>
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
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  stationLaunchButton: {
    paddingVertical: 10,
    paddingHorizontal: 10,
    alignItems: 'center',
    backgroundColor: '#29261e',
    borderColor: '#6c572e',
    borderWidth: 1,
    borderBottomWidth: 3,
    borderBottomColor: '#13120f',
    borderRadius: 5,
  },
  stationLaunchText: {
    color: '#f0b64c',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1,
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
  stationOverlay: {
    ...StyleSheet.absoluteFill,
    zIndex: 5,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 18,
    backgroundColor: 'rgba(0, 0, 0, 0.88)',
  },
  stationPanel: {
    width: '100%',
    maxWidth: 480,
    padding: 20,
    backgroundColor: '#121210',
    borderWidth: 1,
    borderColor: '#62563d',
    borderTopColor: '#aa9567',
    borderBottomWidth: 4,
    borderBottomColor: '#050505',
    borderRadius: 7,
  },
  stationPanelHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    marginBottom: 20,
  },
  stationTitle: {
    color: '#f0ede4',
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 2,
    marginTop: 5,
  },
  stationStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#292923',
    marginBottom: 16,
  },
  stationLed: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: '#382c20',
  },
  stationLedActive: {
    backgroundColor: '#40d26c',
    shadowColor: '#40d26c',
    shadowOpacity: 0.8,
    shadowRadius: 7,
    elevation: 5,
  },
  stationStatus: {
    flexShrink: 1,
    color: '#a8a79e',
    fontFamily: 'Menlo',
    fontSize: 10,
    letterSpacing: 1,
  },
  stationReadoutLabel: {
    color: '#858176',
    fontFamily: 'Menlo',
    fontSize: 9,
    letterSpacing: 1.5,
    marginTop: 12,
  },
  stationReadout: {
    color: '#efc46c',
    fontFamily: 'Menlo',
    fontSize: 13,
    marginTop: 6,
  },
  stationCode: {
    color: '#f2eee3',
    fontFamily: 'Menlo',
    fontSize: 16,
    letterSpacing: 1,
    marginTop: 7,
  },
  transferReadout: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginTop: 5,
  },
  transferRate: {
    color: '#65d98b',
    fontFamily: 'Menlo',
    fontSize: 12,
    marginTop: 12,
  },
  stationError: {
    color: '#ff6961',
    fontFamily: 'Menlo',
    fontSize: 10,
    marginTop: 12,
  },
  stationHint: {
    color: '#96948c',
    fontFamily: 'Menlo',
    fontSize: 10,
    lineHeight: 16,
    marginTop: 18,
  },
  contactSheet: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#343431',
    backgroundColor: '#151512',
    padding: 6,
  },
  contactSheetLoading: {
    backgroundColor: 'transparent',
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
  safelightIndicator: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#ff3b30',
    shadowColor: '#ff3b30',
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 4,
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
  retryButton: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    backgroundColor: '#292927',
    borderColor: '#555550',
    borderTopWidth: 1,
    borderBottomWidth: 3,
    borderRadius: 4,
  },
  retryButtonText: {
    color: '#ff9500',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.5,
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
