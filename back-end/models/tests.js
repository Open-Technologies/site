var squel = require('squel');
var mysql = require('../common/mysql');

var testsModel = {
  getList: function (cb) {
    var query = squel.select()
      .from('test')
      .field('id')
      .field('name');
    mysql.query(query, cb);
  }
};

module.exports = testsModel;