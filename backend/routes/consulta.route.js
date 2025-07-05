const express = require("express");
const router = express.Router();
const { procesarConsulta } = require("../controllers/consulta.controller");

router.post("/", procesarConsulta);

module.exports = router;
