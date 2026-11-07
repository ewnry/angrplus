exports.activate = (api) => {
  api.ui.panel({
    id: 'server-status',
    title: 'Language server',
    position: 'bottom-right',
    refreshMs: 5000,
    read: () => {
      const server = api.data.languageServer();
      return server.ready ? `Работает · порт ${server.port}` : 'Запускается…';
    },
  });
};
