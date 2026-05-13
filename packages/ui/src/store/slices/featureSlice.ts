import type { StateCreator } from 'zustand';
import type { FeatureWithProgress, FeatureStatus } from '../../types/index.js';
import type { UiSlice } from './uiSlice.js';

export interface FeatureSlice {
  features: FeatureWithProgress[];
  allFeaturesLoaded: boolean;
  setFeatures: (features: FeatureWithProgress[]) => void;
  addFeature: (feature: FeatureWithProgress) => void;
  updateFeature: (feature: FeatureWithProgress) => void;
  removeFeature: (featureId: string) => void;
  moveFeatureToColumn: (featureId: string, columnId: string) => void;
  updateFeatureStatus: (featureId: string, status: FeatureStatus) => void;
  updateFeatureProgress: (featureId: string, completed: number, total: number) => void;
}

export const createFeatureSlice: StateCreator<FeatureSlice & UiSlice, [], [], FeatureSlice> = (set) => ({
  features: [],
  allFeaturesLoaded: false,

  setFeatures: (features) =>
    set((state) => ({
      features,
      selectedFeatureIds: state.selectedFeatureIds.filter((id) => features.some((f) => f.id === id)),
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
      selectedFeatureId: state.selectedFeatureId === featureId ? null : state.selectedFeatureId,
      selectedFeatureIds: state.selectedFeatureIds.filter((id) => id !== featureId),
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
