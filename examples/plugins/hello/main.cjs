exports.activate = (api) => {
  api.log('Plugin started. Language server port:', api.getLanguageServerPort());
  return () => api.log('Plugin stopped');
};
