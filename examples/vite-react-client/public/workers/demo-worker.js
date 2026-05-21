self.addEventListener('message', () => {
  self.postMessage('worker-response');
});
