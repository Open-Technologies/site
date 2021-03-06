var _ = require('lodash');
var squel = require('squel');
var doT = require('dot');
var mysql = require('../common/mysql');

var testsModel = {
  getList: function (userId, filters, cb) {
    var query = squel.select()
      .from('test')
      .field('test.id', 'id')
      .field('test.name', 'name')
      .field('test.image', 'image')
      .field('test.description', 'description')
      .where('test.is_active=1')
      .group('test.id');
    switch (filters.status) {
      case 'FINISHED':
        query.join('test_result', null, 'test_result.test_id = test.id AND test_result.user_id=' + mysql.escape(userId));
        break;
      case 'NOT_FINISHED':
        query.left_join('test_result', null, 'test_result.test_id = test.id AND test_result.user_id=' + mysql.escape(userId))
          .where('test_result.id IS NULL');
        break;
    }
    mysql.query(query, cb);
  },

  getCompletedTests: function (userId, cb) {
    var query = squel.select()
      .from('test_result', 't1')
      .field('test.name', 'name')
      .field('test.image', 'image')
      .field('test.short_result_template', 'template')
      .field('t1.params', 'params')
      .join(
        squel.select()
          .from('test_result')
          .field('user_id')
          .field('test_id')
          .field('MAX(timestamp)', 'timestamp')
          .group('user_id, test_id'),
        't2',
        't1.user_id = t2.user_id AND t1.test_id = t2.test_id AND t1.timestamp = t2.timestamp'
      )
      .join('test', null, 'test.id = t1.test_id')
      .where('t1.user_id=?', userId);

    mysql.query(query, function (err, response) {
      if (err) {
        return cb(err);
      }
      var params;
      for (var i = 0; i < response.length; i++) {
        try {
          params = JSON.parse(response[i].params);
        } catch (e) {
          return cb(e);
        }
        response[i].body = doT.compile(response[i].template)(params);
        delete response[i].template;
        delete response[i].params;
      }
      cb(null, response);
    });
  },

  getTest: function (id, cb) {
    const testInfoQuery = squel.select()
      .from('test')
      .field('id')
      .field('name')
      .where('id=?', id)
      .where('is_active=1');
    mysql.query(testInfoQuery, function (err, testInfo) {
      if (err) {
        return cb(err);
      }

      testInfo = testInfo[0];
      if (!testInfo) {
        return cb(Error('Test not found'));
      }

      const questionsQuery = squel.select()
        .from('test_question')
        .field('test_question.id', 'id')
        .field('test_question.body', 'body')
        .field(
          'CONCAT("[",' +
            'GROUP_CONCAT(' +
              'CONCAT("{",' +
                '"\\"id\\":", test_question_variant.id, ",",' +
                '"\\"text\\":\\"", test_question_variant.text, "\\"",' +
              '"}")' +
            '),'+
          '"]")',
        'variants')
        .where('test_question.test_id=?', id)
        .left_join('test_question_variant', null, 'test_question_variant.test_question_id = test_question.id')
        .group('test_question.id');

      mysql.query(questionsQuery, function (err, questionsInfo) {
        if (err) {
          return cb(err);
        }
        try {
          questionsInfo.forEach(function (question) {
            question.variants = JSON.parse(question.variants);
            if (Array.isArray(question.variants)) {
	      question.variants.sort(function (a, b) {
                return a.id - b.id;
              });
            } else {
              question.variants = [];
            }
          });
        } catch (e) {
          return cb(e);
        }
        testInfo.questions = questionsInfo;
        cb(null, testInfo);
      });
    });
  },

  completeTest: function (userId, testId, answers, cb) {
    const query = squel.select()
      .from('test_question_variant')
      .field('value')
      .where('test_question_variant.id IN ?', _.values(answers))
      .join('test_question', null , 'test_question.id = test_question_variant.test_question_id')
      .where('test_question.test_id=?', testId);
    mysql.query(query, function (err, response) {
      if (err) {
        return cb(err);
      }

      var value;
      var key;
      var sum = {};
      for (var i = 0; i < response.length; i++) {
        try {
          value = JSON.parse(response[i].value);
        } catch (e) {
          return cb(e);
        }

        for (key in value) {
          if (!sum[key]) {
            sum[key] = 0;
          }
          sum[key] += value[key];
        }
      }

      var insertQuery = squel.insert()
        .into('test_result')
        .setFields({
          user_id: userId,
          test_id: testId,
          params: JSON.stringify(sum)
        });
      mysql.query(insertQuery, function (err, response) {
        if (err) {
          return cb(err);
        }
        cb(null, response.insertId);
      });
    });
  },

  getResult: function (userId, resultId, cb) {
    var getResultQuery = squel.select()
      .from('test_result')
      .field('params')
      .field('test_id', 'testId')
      .where('id=?', resultId)
      .where('user_id=?', userId);
    mysql.query(getResultQuery, function (err, resultResponse) {
      if (err) {
        return cb(err);
      }

      var params;
      try {
        params = JSON.parse(resultResponse[0].params);
      } catch (e) {
        return cb(e);
      }

      var getTemplateQuery = squel.select()
        .from('test')
        .field('name')
        .field('result_template', 'resultTemplate')
        .where('id=?', resultResponse[0].testId);
      mysql.query(getTemplateQuery, function (err, templateResponse) {
        if (err) {
          return cb(err);
        }
        var result;
        try {
          result = doT.compile(templateResponse[0].resultTemplate)(params);
        } catch (e) {
          return cb(e);
        }
        cb(null, {
          name: templateResponse[0].name,
          body: result
        });
      });
    });
  },

  _getSelfConceptGroup: function (params) {
    if (params.selfConceptLevel > 45) {
      return 'Заниженная';
    } else if (params.selfConceptLevel > 25) {
      return 'Нормальная';
    }
    return 'Завышенная';
  },

  _getTemperamentGroup: function (params) {
    if (params.extraversion >= 12 && params.extraversion <= 24 && params.neuroticism >= 12 && params.neuroticism <= 24) {
      return 'Холерик';
    } else if (params.extraversion >= 0 && params.extraversion <= 12 && params.neuroticism >= 12 && params.neuroticism <= 24) {
      return 'Меланхолик';
    } else if (params.extraversion >= 0 && params.extraversion <= 12 && params.neuroticism >= 0 && params.neuroticism <= 12) {
      return 'Флегматик';
    }
    return 'Сангвиник';
  },

  _getAggressionGroup: function (params) {
    if (params.p_a + params.irr + params.v_a >=0 && params.p_a + params.irr + params.v_a < 17) {
      return 'Низкая';
    } else if (params.p_a + params.irr + params.v_a >=17 && params.p_a + params.irr + params.v_a <=25) {
      return 'Средняя';
    } else if (params.p_a + params.irr + params.v_a > 25) {
      return 'Высокая';
    }
  },

  getStats: function (cb) {
    var query = squel.select()
      .from('test_result', 'result')
      .field('result.test_id', 'id')
      .field('result.params', 'params')
      .join(
        squel.select()
          .from('test_result')
          .field('user_id')
          .field('test_id')
          .field('MAX(timestamp)', 'timestamp')
          .group('user_id, test_id'),
        'last',
        'result.user_id = last.user_id AND result.test_id = last.test_id AND result.timestamp = last.timestamp'
      )
      .where('result.test_id IN (1, 2, 3)');
    mysql.query(query, function (err, result) {
      if (err) {
        return cb(err);
      }

      var stats = {
        selfConcept: {},
        temperament: {},
        aggression: {}
      };
      var group;
      for (var i = 0; i < result.length; i++) {
        switch (result[i].id) {
          case 1:
            group = this._getTemperamentGroup(JSON.parse(result[i].params));
            if (!stats.temperament[group]) {
              stats.temperament[group] = 0;
            }
            stats.temperament[group] ++;
            break;
          case 2:
            group = this._getSelfConceptGroup(JSON.parse(result[i].params));
            if (!stats.selfConcept[group]) {
              stats.selfConcept[group] = 0;
            }
            stats.selfConcept[group] ++;
            break;
          case 3:
            group = this._getAggressionGroup(JSON.parse(result[i].params));
            if (!stats.aggression[group]) {
              stats.aggression[group] = 0;
            }
            stats.aggression[group] ++;
            break;
        }
      }
      cb(null, stats);
    }.bind(this));
  }
};

module.exports = testsModel;
