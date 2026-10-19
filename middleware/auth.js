function requireAuth(req, res, next) {
  if (req.session && req.session.user && (req.session.user.role === 'admin' || req.session.user.role === 'staff')) {
    return next();
  }
  if (req.xhr || req.headers.accept?.includes('json')) {
    return res.status(401).json({ success: false, error: 'Unauthorized. Please log in.' });
  }
  req.flash('error', 'Please log in to access the admin area.');
  res.redirect('/admin/login');
}

function redirectIfAuthenticated(req, res, next) {
  if (req.session && req.session.user && (req.session.user.role === 'admin' || req.session.user.role === 'staff')) {
    return res.redirect('/admin');
  }
  next();
}

function requirePlayerAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  if (req.xhr || req.headers.accept?.includes('json')) {
    return res.status(401).json({
      success: false,
      requiresAuth: true,
      error: 'Please log in or sign up to book a court.'
    });
  }
  req.flash('error', 'Please log in or create an account before booking a court.');
  res.redirect('/account/login');
}

module.exports = { requireAuth, redirectIfAuthenticated, requirePlayerAuth };
