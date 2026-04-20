const express = require('express')
const router = express.Router()

router.post('/', async (req, res) => {
  res.status(501).json({ message: 'Voice endpoint — Session 2' })
})

module.exports = router
