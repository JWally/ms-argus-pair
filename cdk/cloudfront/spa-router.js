// eslint-disable-next-line no-unused-vars
function handler(event) {
  var request = event.request;
  var uri = request.uri || '/';

  if (uri === '/' || uri === '') {
    request.uri = '/index.html';
    return request;
  }

  if (uri.indexOf('/api/') === 0 || uri.indexOf('/assets/') === 0) {
    return request;
  }

  if (uri.indexOf('/pair/') === 0) {
    request.uri = '/phone.html';
    return request;
  }

  var last = uri.split('/').pop() || '';
  if (last.indexOf('.') !== -1) {
    return request;
  }

  request.uri = '/index.html';
  return request;
}
