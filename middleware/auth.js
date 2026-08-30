function requireAuth(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  if (req.xhr || req.headers.accept?.includes('json')) {
    return res.status(401).json({ success: false, error: 'Unauthorized. Please log in.' });
  }
  req.flash('error', 'Please log in to access the admin area.');
  res.redirect('/admin/login');
}

function redirectIfAuthenticated(req, res, next) {
  if (req.session && req.session.user) {
    return res.redirect('/admin');
  }
  next();
}

module.exports = { requireAuth, redirectIfAuthenticated };
