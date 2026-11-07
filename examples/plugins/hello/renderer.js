if (!document.getElementById('hello-plus-badge')) {
  const badge = document.createElement('div');
  badge.id = 'hello-plus-badge';
  badge.textContent = 'Hello Plus';
  document.body.appendChild(badge);
}
