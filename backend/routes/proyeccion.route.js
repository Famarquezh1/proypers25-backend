const express = require("express");
const router = express.Router();
const { calcularProyeccion } = require("../controllers/proyeccion.controller");

router.get("/:symbol", calcularProyeccion);

module.exports = router;
