import { Menu, MenuItem, MenuItemConstructorOptions, shell } from 'electron';
import { createWindow, isMacOS } from './utils';
import { MenuUpdateStep, updateActions } from './updater';


export function setupApplicationMenu(url: string): void {
  const menu = Menu.getApplicationMenu();
  if (!menu) {
    return;
  }

  addItemToSubmenu(
    menu,
    'File',
    0,
    new MenuItem({
      label: 'New Window',
      accelerator: 'CmdOrCtrl+Shift+N',
      click: () => {
        createWindow(url);
      },
    }),
  );

  if (isMacOS()) {
    const appSubmenu = menu.items[0]?.submenu;
    if (appSubmenu) {
      appSubmenu.insert(
        1,
        new MenuItem({
          id: 'check-for-updates',
          label: MenuUpdateStep.CheckForUpdates,
          click: (menuItem) => {
            const action = updateActions[menuItem.label];
            action?.();
          },
        }),
      );
    }
  }

  addItemToSubmenu(
    menu,
    'Help',
    0,
    new MenuItem({
      label: 'Docs',
      click: async () => {
        await shell.openExternal('https://antigravity.google/docs');
      },
    }),
  );
  addItemToSubmenu(
    menu,
    'Help',
    1,
    new MenuItem({
      role: 'toggleDevTools',
    }),
  );

  Menu.setApplicationMenu(menu);
}


function addItemToSubmenu(appMenu: Menu, submenuLabel: string, position: number, item: MenuItem): void {
  const submenuItem = appMenu.items.find((item) => item.label === submenuLabel);
  if (!submenuItem?.submenu) {
    return;
  }
  submenuItem.submenu.insert(position, item);
}
