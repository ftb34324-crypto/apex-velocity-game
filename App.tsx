import { useCallback, useEffect, useRef, useState } from 'react';
import { AndroidGuideModal } from './components/AndroidGuideModal';
import { GarageScreen } from './components/GarageScreen';
import { OfflineIndicator } from './components/PWAInstallButton';
import { PostRaceModal } from './components/PostRaceModal';
import { RaceHUD } from './components/RaceHUD';
import {
  CARS,
  DEFAULT_UPGRADES,
  getUpgradeCost,
  loadSaveData,
  persistSaveData,
} from './data/gameData';
import { soundEngine } from './engine/audioEngine';
import { RacingEngine, type InputState } from './engine/RacingEngine';
import type {
  CarCustomization,
  CarUpgrades,
  GameMode,
  LiveTelemetry,
  MissionSpec,
  PlayerSaveData,
  RaceResult,
  TrackId,
} from './types/game';

const INITIAL_TELEMETRY: LiveTelemetry = {
  speedKmh: 0,
  maxSpeedReached: 0,
  rpm: 0.2,
  gear: 1,
  nitro: 100,
  isBoosting: false,
  isDrifting: false,
  driftPointsActive: 0,
  totalDriftScore: 0,
  nearMissCount: 0,
  airStuntsCount: 0,
  coinsCollected: 0,
  raceScore: 0,
  lap: 1,
  totalLaps: 2,
  position: 1,
  totalRacers: 4,
  elapsedSec: 0,
  timeRemainingSec: 0,
  countdown: 3,
  progressRatio: 0,
  minimapPlayer: { x: 0, z: 0, heading: 0 },
  minimapRivals: [],
  popupEvent: null,
};

export default function App() {
  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<RacingEngine | null>(null);

  const [saveData, setSaveData] = useState<PlayerSaveData>(() => loadSaveData());
  const [screen, setScreen] = useState<'garage' | 'race'>('garage');
  const [paused, setPaused] = useState(false);
  const [showAndroidGuide, setShowAndroidGuide] = useState(false);
  const [contextLost, setContextLost] = useState(false);

  const [activeSession, setActiveSession] = useState<{
    trackId: TrackId;
    mode: GameMode;
    mission: MissionSpec | null;
  }>({ trackId: 'metro-night', mode: 'race', mission: null });

  const [telemetry, setTelemetry] = useState<LiveTelemetry>(INITIAL_TELEMETRY);
  const [raceResult, setRaceResult] = useState<RaceResult | null>(null);

  const saveDataRef = useRef(saveData);
  saveDataRef.current = saveData;

  const screenRef = useRef(screen);
  screenRef.current = screen;

  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // Persist save changes
  useEffect(() => {
    persistSaveData(saveData);
    soundEngine.setSettings(saveData.sfxEnabled, saveData.musicEnabled);
  }, [saveData]);

  // Mount Three.js RacingEngine once
  useEffect(() => {
    const mount = canvasMountRef.current;
    if (!mount) return;

    const engine = new RacingEngine(mount, {
      onTelemetry: (t) => {
        setTelemetry(t);
      },
      onRaceFinish: (result) => {
        setRaceResult(result);
        setSaveData((prev) => {
          const nextCompleted =
            result.victory && result.missionId && !prev.completedMissions.includes(result.missionId)
              ? [...prev.completedMissions, result.missionId]
              : prev.completedMissions;

          const nextBest = { ...prev.bestLapTimes };
          if (result.bestLapSec !== null) {
            const existing = nextBest[result.trackId];
            if (!existing || result.bestLapSec < existing) {
              nextBest[result.trackId] = result.bestLapSec;
            }
          }

          return {
            ...prev,
            coins: prev.coins + result.coinsEarned,
            totalScore: prev.totalScore + result.scoreEarned,
            completedMissions: nextCompleted,
            bestLapTimes: nextBest,
          };
        });
      },
      onContextLost: () => setContextLost(true),
    });

    engineRef.current = engine;
    const initial = saveDataRef.current;
    const car = CARS.find((c) => c.id === initial.selectedCarId) || CARS[0];
    engine.showGarageCar(car.id, initial.customizations[car.id] || car.defaultCustomization);

    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  // Sync garage car updates whenever selection or customization changes in garage
  useEffect(() => {
    if (screen !== 'garage' || !engineRef.current) return;
    const car = CARS.find((c) => c.id === saveData.selectedCarId) || CARS[0];
    const custom = saveData.customizations[car.id] || car.defaultCustomization;
    engineRef.current.showGarageCar(car.id, custom);
  }, [screen, saveData.selectedCarId, saveData.customizations]);

  // Keyboard Controls during Race
  useEffect(() => {
    const handleKey = (isDown: boolean) => (e: KeyboardEvent) => {
      if (screenRef.current !== 'race' || !engineRef.current) return;
      const code = e.code;

      if (isDown && (code === 'Escape' || code === 'KeyP')) {
        setPaused((p) => {
          const next = !p;
          engineRef.current?.setPaused(next);
          return next;
        });
        return;
      }

      if (isDown && code === 'KeyC') {
        engineRef.current.cycleCameraMode();
        return;
      }

      const inp = engineRef.current.input;
      if (code === 'KeyW' || code === 'ArrowUp') inp.throttle = isDown;
      if (code === 'KeyS' || code === 'ArrowDown') inp.brake = isDown;
      if (code === 'KeyA' || code === 'ArrowLeft') inp.left = isDown;
      if (code === 'KeyD' || code === 'ArrowRight') inp.right = isDown;
      if (code === 'Space') {
        e.preventDefault();
        inp.nitro = isDown;
      }
      if (code === 'ShiftLeft' || code === 'ShiftRight') inp.drift = isDown;
    };

    const downFn = handleKey(true);
    const upFn = handleKey(false);
    window.addEventListener('keydown', downFn);
    window.addEventListener('keyup', upFn);
    return () => {
      window.removeEventListener('keydown', downFn);
      window.removeEventListener('keyup', upFn);
    };
  }, []);

  const handleSelectCar = useCallback((carId: string) => {
    soundEngine.unlock();
    setSaveData((prev) => ({ ...prev, selectedCarId: carId }));
  }, []);

  const handleUnlockCar = useCallback((carId: string, price: number) => {
    soundEngine.unlock();
    setSaveData((prev) => {
      if (prev.unlockedCars.includes(carId) || prev.coins < price) return prev;
      soundEngine.playCoin();
      return {
        ...prev,
        coins: prev.coins - price,
        unlockedCars: [...prev.unlockedCars, carId],
        selectedCarId: carId,
      };
    });
  }, []);

  const handleUpdateCustomization = useCallback((carId: string, patch: Partial<CarCustomization>) => {
    soundEngine.unlock();
    setSaveData((prev) => {
      const car = CARS.find((c) => c.id === carId) || CARS[0];
      const current = prev.customizations[carId] || car.defaultCustomization;
      return {
        ...prev,
        customizations: {
          ...prev.customizations,
          [carId]: { ...current, ...patch },
        },
      };
    });
  }, []);

  const handleUpgradePart = useCallback((carId: string, part: keyof CarUpgrades) => {
    soundEngine.unlock();
    setSaveData((prev) => {
      const current = prev.upgrades[carId] || { ...DEFAULT_UPGRADES };
      const lv = current[part];
      if (lv >= 5) return prev;
      const cost = getUpgradeCost(lv);
      if (prev.coins < cost) return prev;
      soundEngine.playNitroPickup();
      return {
        ...prev,
        coins: prev.coins - cost,
        upgrades: {
          ...prev.upgrades,
          [carId]: { ...current, [part]: lv + 1 },
        },
      };
    });
  }, []);

  const handleToggleAudio = useCallback(() => {
    soundEngine.unlock();
    setSaveData((prev) => {
      const next = !(prev.sfxEnabled || prev.musicEnabled);
      return { ...prev, sfxEnabled: next, musicEnabled: next };
    });
  }, []);

  const handleStartRace = useCallback(
    (trackId: TrackId, mode: GameMode, mission: MissionSpec | null) => {
      soundEngine.unlock();
      if (!engineRef.current) return;
      const s = saveDataRef.current;
      const car = CARS.find((c) => c.id === s.selectedCarId) || CARS[0];
      const custom = s.customizations[car.id] || car.defaultCustomization;
      const upgrades = s.upgrades[car.id] || DEFAULT_UPGRADES;

      setActiveSession({ trackId, mode, mission });
      setRaceResult(null);
      setPaused(false);
      setTelemetry(INITIAL_TELEMETRY);
      setScreen('race');

      engineRef.current.startSession({
        carId: car.id,
        customization: custom,
        upgrades,
        trackId,
        gameMode: mode,
        mission,
      });
    },
    [],
  );

  const handleInputChange = useCallback((patch: Partial<InputState>) => {
    soundEngine.unlock();
    if (!engineRef.current) return;
    Object.assign(engineRef.current.input, patch);
  }, []);

  const handleExitToGarage = useCallback(() => {
    setRaceResult(null);
    setPaused(false);
    setScreen('garage');
    if (engineRef.current) {
      const s = saveDataRef.current;
      const car = CARS.find((c) => c.id === s.selectedCarId) || CARS[0];
      engineRef.current.showGarageCar(car.id, s.customizations[car.id] || car.defaultCustomization);
    }
  }, []);

  return (
    <main className="relative w-full h-full overflow-hidden bg-[#0A0D14]">
      {/* Isolated Full-Viewport WebGL Canvas Container */}
      <div ref={canvasMountRef} className="fixed inset-0 w-full h-full" />

      <OfflineIndicator />

      {contextLost && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0A0D14] p-6">
          <div className="max-w-sm rounded-xl border border-white/15 bg-[#121826] p-6 text-center">
            <h2 className="font-display text-xl font-bold text-white">Graphics Context Interrupted</h2>
            <p className="mt-2 text-xs text-slate-300">
              Your device reset the 3D WebGL context. Reload to resume racing.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 rounded-lg bg-amber-500 px-4 py-2 text-xs font-bold text-slate-950 cursor-pointer"
            >
              Reload Game
            </button>
          </div>
        </div>
      )}

      {screen === 'garage' && (
        <GarageScreen
          saveData={saveData}
          onSelectCar={handleSelectCar}
          onUnlockCar={handleUnlockCar}
          onUpdateCustomization={handleUpdateCustomization}
          onUpgradePart={handleUpgradePart}
          onToggleAudio={handleToggleAudio}
          onOpenAndroidGuide={() => setShowAndroidGuide(true)}
          onStartRace={handleStartRace}
        />
      )}

      {screen === 'race' && !raceResult && (
        <RaceHUD
          telemetry={telemetry}
          trackId={activeSession.trackId}
          gameMode={activeSession.mode}
          mission={activeSession.mission}
          paused={paused}
          controlScheme={saveData.controlScheme}
          audioEnabled={saveData.sfxEnabled || saveData.musicEnabled}
          onInputChange={handleInputChange}
          onToggleControlScheme={() =>
            setSaveData((prev) => ({
              ...prev,
              controlScheme: prev.controlScheme === 'buttons' ? 'wheel' : 'buttons',
            }))
          }
          onCycleCamera={() => engineRef.current?.cycleCameraMode()}
          onToggleAudio={handleToggleAudio}
          onTogglePause={() => {
            setPaused((p) => {
              const next = !p;
              engineRef.current?.setPaused(next);
              return next;
            });
          }}
          onRestart={() =>
            handleStartRace(activeSession.trackId, activeSession.mode, activeSession.mission)
          }
          onExitToGarage={handleExitToGarage}
          onFinishFreeRoam={() => engineRef.current?.endFreeRoam()}
        />
      )}

      {raceResult && (
        <PostRaceModal
          result={raceResult}
          onRetry={() =>
            handleStartRace(activeSession.trackId, activeSession.mode, activeSession.mission)
          }
          onGarage={handleExitToGarage}
        />
      )}

      {showAndroidGuide && (
        <AndroidGuideModal onClose={() => setShowAndroidGuide(false)} />
      )}
    </main>
  );
}
