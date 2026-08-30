function errorHandler(err, req, res, next) {
  console.error('[Error Handler]:', err);

  if (res.headersSent) {
    return next(err);
  }

  const statusCode = err.status || 500;
  const isJson = req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'));

  if (isJson) {
    return res.status(statusCode).json({
      success: false,
      error: err.message || 'An unexpected server error occurred.'
    });
  }

  res.status(statusCode).render('pages/error', {
    title: 'Error - PicklePlay Pro',
    message: err.message || 'An unexpected server error occurred.',
    statusCode,
    user: req.session ? req.session.user : null
  });
}

function notFoundHandler(req, res, next) {
  const isJson = req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'));
  if (isJson) {
    return res.status(404).json({ success: false, error: 'Resource not found.' });
  }

  res.status(404).render('pages/error', {
    title: 'Page Not Found',
    message: 'The page or resource you requested could not be found.',
    statusCode: 404,
    user: req.session ? req.session.user : null
  });
}

module.exports = { errorHandler, notFoundHandler };
