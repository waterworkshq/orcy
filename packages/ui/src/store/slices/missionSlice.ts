import type { StateCreator } from 'zustand';
import type { MissionWithProgress, MissionStatus } from '../../types/index.js';
import type { UiSlice } from './uiSlice.js';

export interface MissionSlice {
  features: MissionWithProgress[];
  allFeaturesLoaded: boolean;
  setFeatures: (features: MissionWithProgress[]) => void;
  addFeature: (feature: MissionWithProgress) => void;
  updateFeature: (feature: MissionWithProgress) => void;
  removeFeature: (featureId: string) => void;
  moveFeatureToColumn: (featureId: string, columnId: string) => void;
  updateFeatureStatus: (featureId: string, status: MissionStatus) => void;
  updateFeatureProgress: (featureId: string, completed: number, total: number) => void;
}

export const createMissionSlice: StateCreator<MissionSlice & UiSlice, [], [], MissionSlice> = (set) => ({
  features: [],
  allFeaturesLoaded: false,

  setFeatures: (features) =>
    set((state) => ({
      features,
      selectedMissionIds: state.selectedMissionIds.filter((id) => features.some((f) => f.id === id)),
    })),

  addFeature: (feature) =>
    set((state) => ({
      features: [...state.features, feature],
    })),

  updateFeature: (feature) =>
    set((state) => ({
      features: state.features.map((f) => (f.id === feature.id ? feature : f)),
    })),

  removeFeature: (featureId) =>
    set((state) => ({
      features: state.features.filter((f) => f.id !== featureId),
      selectedMissionId: state.selectedMissionId === featureId ? null : state.selectedMissionId,
      selectedMissionIds: state.selectedMissionIds.filter((id) => id !== featureId),
    })),

  moveFeatureToColumn: (featureId, columnId) =>
    set((state) => ({
      features: state.features.map((f) =>
        f.id === featureId ? { ...f, columnId } : f
      ),
    })),

  updateFeatureStatus: (featureId, status) =>
    set((state) => ({
      features: state.features.map((f) =>
        f.id === featureId ? { ...f, status } : f
      ),
    })),

  updateFeatureProgress: (featureId, completed, total) =>
    set((state) => ({
      features: state.features.map((f) =>
        f.id === featureId
          ? {
              ...f,
              progress: {
                ...f.progress,
                total,
                done: completed,
                percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
              },
            }
          : f
      ),
    })),
});
