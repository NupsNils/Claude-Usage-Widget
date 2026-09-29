import { DEFAULT_COLORS } from '../shared/gradient';
import {
  DEFAULT_SETTINGS,
  applySettingsPatch,
  normalizeSettings,
  normalizeWidgetHeight,
  normalizeWidgetWidth,
} from '../shared/settings';
import type { Settings, WindowPosition } from '../shared/types';
import { readJsonFile, writeJsonFileAtomic } from './jsonFile';

function copySettings(settings: Settings): Settings {
  return {
    ...settings,
    colors: { ...settings.colors },
    widgetPosition: settings.widgetPosition ? { ...settings.widgetPosition } : null,
  };
}

/** Loads and saves the settings file. Invalid values are replaced by defaults. */
export class SettingsStore {
  private settings: Settings = normalizeSettings(undefined);

  constructor(private readonly filePath: string) {}

  load(): Settings {
    const result = readJsonFile(this.filePath);
    this.settings = normalizeSettings(result.status === 'ok' ? result.value : undefined);
    return this.get();
  }

  get(): Settings {
    return copySettings(this.settings);
  }

  /** Applies a patch from the settings window; returns the new settings. */
  update(patch: unknown): Settings {
    return this.commit(applySettingsPatch(this.settings, patch));
  }

  resetColors(): Settings {
    return this.commit({ ...this.settings, colors: { ...DEFAULT_COLORS } });
  }

  setWidgetPosition(position: WindowPosition): Settings {
    return this.commit({ ...this.settings, widgetPosition: normalizeSettings({ widgetPosition: position }).widgetPosition });
  }

  /** Stores the size the user resized the widget to; a null height means "fit the content". */
  setWidgetSize(width: number, height: number | null): Settings {
    return this.commit({ ...this.settings, widgetWidth: normalizeWidgetWidth(width), widgetHeight: normalizeWidgetHeight(height) });
  }

  resetWidgetSize(): Settings {
    return this.commit({ ...this.settings, widgetWidth: DEFAULT_SETTINGS.widgetWidth, widgetHeight: DEFAULT_SETTINGS.widgetHeight });
  }

  private commit(next: Settings): Settings {
    writeJsonFileAtomic(this.filePath, next);
    this.settings = next;
    return this.get();
  }
}
