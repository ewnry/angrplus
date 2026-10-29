import { app, Menu, MenuItemConstructorOptions, nativeImage, Tray } from 'electron';
import * as path from 'path';
import { isMacOS } from './utils';


let tray: Tray | null = null;
let contextMenu: Menu | null = null;


export function createTray(actions: MenuItemConstructorOptions[]): void {



  const iconFile = isMacOS() ? 'trayTemplate.png' : 'icon.png';
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', iconFile));
  if (isMacOS()) {
    icon.setTemplateImage(true);
  }
  tray = new Tray(icon);
  tray.setToolTip(app.getName());
  contextMenu = Menu.buildFromTemplate(actions);
  tray.setContextMenu(contextMenu);
}


export function updateTrayAgentCount(count: number): void {
  if (tray && contextMenu) {
    const countItem = contextMenu.items.find((item) => item.id === 'running-agents');
    if (countItem) {
      countItem.label = (count > 0 ? `${count}` : 'No') + ' agent' + (count === 1 ? '' : 's') + ' running';
      tray.setContextMenu(contextMenu);
    }
  }
}
