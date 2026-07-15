const express = require('express');
const crypto = require('crypto');
const https = require('https');
const db = require('../firebase-admin-config');
const { getBinanceSpotCredentials } = require('../lib/secretManager');

const router = express.Router();

const OPEN_POSITIONS_COLLECTION = 'real_spot_positions';
const RESULTS_COLLECTION = 'real_spot_execution_results';

function validateSummarySecret(req, res, next) {
  const supplied = req.headers['x-investments-secret'] || req.headers['x-cron