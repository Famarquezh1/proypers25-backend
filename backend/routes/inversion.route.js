const express = require('express');
const router = express.Router();

const inversionController = require('../controllers/inversion.controller');
router.get('/recomendacion', inversionController.obtenerRecomendacion);

module.exports = router;

