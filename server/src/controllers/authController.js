const jwt = require('jsonwebtoken');
const config = require('../config');
const User = require('../models/User');
const Team = require('../models/Team');
const TeamMember = require('../models/TeamMember');
const ApiError = require('../utils/ApiError');

// ── Helpers ──────────────────────────────────────────
const generateToken = (userId) => {
  return jwt.sign({ id: userId }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  });
};

const setTokenCookie = (res, token) => {
  res.cookie('token', token, {
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
};

// ── POST /api/auth/register ──────────────────────────
exports.register = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;

    // Check for existing account
    const existing = await User.findOne({ email });
    if (existing) {
      throw new ApiError(409, 'An account with this email already exists.');
    }

    // Create user
    const user = await User.create({ name, email, password });

    // Create a default personal workspace for the new user
    const team = await Team.create({
      name: `${name}'s Team`,
      description: 'Default personal workspace',
      owner: user._id,
    });

    // Add the user as team owner
    await TeamMember.create({
      team: team._id,
      user: user._id,
      role: 'owner',
    });

    const token = generateToken(user._id);
    setTokenCookie(res, token);

    res.status(201).json({
      success: true,
      message: 'Registration successful',
      data: {
        user: { id: user._id, name: user.name, email: user.email },
        team: { id: team._id, name: team.name },
        token,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/auth/login ─────────────────────────────
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      throw new ApiError(401, 'Invalid email or password.');
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      throw new ApiError(401, 'Invalid email or password.');
    }

    const token = generateToken(user._id);
    setTokenCookie(res, token);

    // Return user's teams
    const memberships = await TeamMember.find({ user: user._id }).populate('team', 'name');
    const teams = memberships.map((m) => ({
      id: m.team._id,
      name: m.team.name,
      role: m.role,
    }));

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: { id: user._id, name: user.name, email: user.email },
        teams,
        token,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/auth/me ─────────────────────────────────
exports.getProfile = async (req, res, next) => {
  try {
    const memberships = await TeamMember.find({ user: req.user._id }).populate(
      'team',
      'name description'
    );

    const teams = memberships.map((m) => ({
      id: m.team._id,
      name: m.team.name,
      description: m.team.description,
      role: m.role,
    }));

    res.json({
      success: true,
      data: {
        user: {
          id: req.user._id,
          name: req.user.name,
          email: req.user.email,
          createdAt: req.user.createdAt,
        },
        teams,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── PUT /api/auth/profile ────────────────────────────
exports.updateProfile = async (req, res, next) => {
  try {
    const { name, email } = req.body;
    const updates = {};

    if (name) updates.name = name;
    if (email) {
      const taken = await User.findOne({ email, _id: { $ne: req.user._id } });
      if (taken) {
        throw new ApiError(409, 'This email is already in use by another account.');
      }
      updates.email = email;
    }

    const user = await User.findByIdAndUpdate(req.user._id, updates, {
      new: true,
      runValidators: true,
    });

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: {
        user: { id: user._id, name: user.name, email: user.email },
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── PUT /api/auth/change-password ────────────────────
exports.changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const user = await User.findById(req.user._id).select('+password');

    const isCorrect = await user.comparePassword(currentPassword);
    if (!isCorrect) {
      throw new ApiError(401, 'Current password is incorrect.');
    }

    user.password = newPassword;
    await user.save(); // triggers pre-save hash

    const token = generateToken(user._id);
    setTokenCookie(res, token);

    res.json({
      success: true,
      message: 'Password changed successfully',
      data: { token },
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/auth/logout ────────────────────────────
exports.logout = (req, res) => {
  res.cookie('token', '', {
    httpOnly: true,
    expires: new Date(0),
  });

  res.json({
    success: true,
    message: 'Logged out successfully',
  });
};
