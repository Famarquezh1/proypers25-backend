const express = require('express');
const crypto = require('crypto');
const https = require('https');
const db = require('../firebase-admin-config');
const { getBinanceSpotCredentials } = require('../lib/secretManager');

const router = express.Router();

function validateSummarySecret(req, res, next) {
  const supplied = req.headers['x-investments-secret'] || req.headers['x-cron-secret'];
  const expected = process.env.INVESTMENTS_SUMMARY_SECRET || process.env.CRON_SECRET;

  if (!expected) {
    return res.status(503).json