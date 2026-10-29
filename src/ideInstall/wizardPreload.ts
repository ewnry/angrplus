

import { contextBridge, ipcRenderer } from 'electron';

interface WizardAPI {
  completeWizard: (shouldDownload: boolean) => Promise<void>;
  onSetupComplete: (callback: () => void) => () => void;
}

const wizardAPI: WizardAPI = {
  completeWizard: (shouldDownload) => ipcRenderer.invoke('wizard:complete', shouldDownload),
  onSetupComplete: (callback) => {
    const handler = () => {
      callback();
    };
    ipcRenderer.on('wizard:setup-complete', handler);
    return () => {
      ipcRenderer.removeListener('wizard:setup-complete', handler);
    };
  },
};

contextBridge.exposeInMainWorld('wizardAPI', wizardAPI);

declare global {
  interface Window {
    wizardAPI: WizardAPI;
  }
}
