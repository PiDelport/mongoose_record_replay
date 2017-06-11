/**
 * instrument mongoose to record/replay queries ( !! only queries so far)
 *
 * allows to run (mongoose read only) unit tests w.o. a mongoose instance
 *
 * @file
 */

import * as debugf from 'debugf';

var debuglog = debugf('mongoose_record_replay');
//const loadlog = logger.logger('modelload', '');

import * as process from 'process';
import * as mongoose from 'mongoose';
import * as events from 'events';
import * as fs from 'fs';
const crypto = require('crypto');


/**
 * The recording path, set via argument
 * or
 */
var recordingPath = 'mongoose_record_replay/';
var serializePath = 'mgrecrep/';

var theMode = undefined;

export function JSONParse(text: string): any {
    function customDeSer(key, value) {
        if (value.toString().indexOf("__REGEXP ") == 0) {
            var m = value.split("__REGEXP ")[1].match(/\/(.*)\/(.*)?/);
            return new RegExp(m[1], m[2] || "");
        } else
            return value;
    }
    return JSON.parse(text, customDeSer);
}



export function JSONStringify(obj: any): string {
    function customSer(key, value) {
        if (value instanceof RegExp){
            return ("__REGEXP " + value.toString());
        }
        else
            return value;
    }
    return JSON.stringify(obj, customSer, 2);
}

function readFileAsJSON(filename: string): any {
    var data = fs.readFileSync(filename, 'utf-8');
    try {
        return JSON.parse(data);
    } catch (e) {
        console.log("Content of file " + filename + " is no json" + e);
        process.exit(-1);
    }
    return undefined;
}


function assurePath(path: string) {
    try {
        fs.mkdirSync(path);
    } catch (e) {

    }
    try {
        fs.mkdirSync(path + 'data');
    } catch (e) {

    }
}

var dbEmitter = new events.EventEmitter();
// unit test invoke this multiple times, avoid node js warning
dbEmitter.setMaxListeners(0);


export function instrumentModel(model: mongoose.Model<any>) {
    if (theMode === "RECORD") {
        instrumentModelRecord(model);
    } else if (theMode === "REPLAY") {
        // todo
        instrumentModelReplay(model);
    }
    return model;
}


function makeFileName(digest) {
    return (recordingPath + 'data/' + digest + '.json');
}

export function recordOp(op: string, name: string, query: any, res: any) {
    var md5sum = crypto.createHash('md5');
    debuglog('here the name ' + name);
    md5sum.update(op + name + JSONStringify(query));
    var digest = md5sum.digest('hex');
    fs.writeFileSync(makeFileName(digest), JSON.stringify(res, undefined, 2));

    var known = {};
    try {
        known = readFileAsJSON(recordingPath + 'queries.json');
    } catch (ex) {

    }
    known[digest] = {
        op: op,
        name: name,
        digest: digest,
        query: query,
        res: res
    };
    fs.writeFileSync(recordingPath + 'queries.json', JSONStringify(known));
}

export function retrieveOp(op: string, name: string, query: any) {
    var md5sum = crypto.createHash('md5');
    md5sum.update(op + name + JSONStringify(query));
    var digest = md5sum.digest('hex');
    var filename = makeFileName(digest);
    debuglog(' filename ' + filename);
    try {
        var res = readFileAsJSON(filename);
    } catch(e) {
        console.log(e);
        console.log(e.stack);
        console.log(`did not find query result recording (${filename}) \n for collection ${name} operation ${op} \n query arguments: ` + JSONStringify(query));
        throw e;
    }
    if (res === undefined) {
        debuglog('empty result for query ' + op + ' ' + JSON.stringify(query, undefined, 2) + '\n' + filename);
    }
    return res;
}

export function instrumentModelRecord(modelDoc: mongoose.Model<any>) {
    console.log('mongoose_record_replay is instrumenting model ' + modelDoc.modelName + ' for recording ');
    var oFind = modelDoc.find;
    modelDoc.find = function (): any {
        debuglog('someone is calling find with ' + modelDoc.modelName + JSON.stringify(arguments, undefined, 2));
        var res = oFind.apply(modelDoc, arguments);
        if (arguments.length !== 1) {
            throw Error('expected one arguments in find, was ' + arguments.length);
        }
        var query = arguments[0];
        res.lean().exec().then((a) => {
            //console.log("here result1 + " + JSON.stringify(a, undefined,2) );
            recordOp("find", modelDoc.modelName, query, a);
        }
        );
        return res;
    }
    var oDistinct = modelDoc.distinct;
    modelDoc.distinct = function (): any {
        debuglog('someone is calling distinct with' + JSON.stringify(arguments, undefined, 2));
        var res = oDistinct.apply(modelDoc, arguments);
        if (arguments.length !== 1) {
            throw Error('expected on arguments');
        }
        var query = arguments[0];
        res.then((a) => {
            // console.log("here result1 + " + JSON.stringify(a, undefined,2) );
            recordOp("distinct", modelDoc.modelName, query, a);
        }
        );
        return res;
    }
    var oAggregate = modelDoc.aggregate;
    modelDoc.aggregate = function (): any {
        debuglog(() => 'someone is calling aggregate with' + JSON.stringify(arguments, undefined, 2));
        var query = Array.prototype.slice.call(arguments);
        var res = oAggregate.apply(modelDoc, arguments);
        res.then((a) => {
            debuglog(() => "here result1 + " + JSON.stringify(a, undefined, 2));
            recordOp("aggregate", modelDoc.modelName, query, a);
        }
        );
        return res;
    }
}

export function instrumentModelReplay(modelDoc: mongoose.Model<any>) {
    debuglog('instrumenting model ' + modelDoc.modelName);
    var oFind = modelDoc.find;
    modelDoc.find = function (): any {
        debuglog(() => 'someone is replaying find with' + JSON.stringify(arguments, undefined, 2));
        var query = arguments[0];
        var res = retrieveOp("find", modelDoc.modelName, query);
        debuglog(() => 'returning res ' + JSON.stringify(res) + ' for query find' + query);
        return {
            lean: function () {
                return {
                    exec: function () {
                        return new Promise(function (resolve, reject) {
                            setTimeout(function () {
                                resolve(res);
                            }, 0);
                        });
                    }
                }
            }
        }
    }
    var oDistinct = modelDoc.distinct;
    modelDoc.distinct = function (): any {
        debuglog('someone is replaying distinct with' + JSON.stringify(arguments, undefined, 2));
        var query = arguments[0];
        var res = retrieveOp("distinct", modelDoc.modelName, query);
        debuglog('returning res ' + JSON.stringify(res) + ' for query find' + query);
        return new Promise(function (resolve, reject) {
            setTimeout(function () { resolve(res); }, 0);
        });
    }
    var oAggregate = modelDoc.aggregate;
    modelDoc.aggregate = function (): any {
        debuglog('someone is replaying aggregate with' + JSON.stringify(arguments, undefined, 2));
        var query = Array.prototype.slice.call(arguments);
        var res = retrieveOp("aggregate", modelDoc.modelName, query);
        var p = new Promise(function (resolve, reject) {
            setTimeout(function () { resolve(res); }, 0);
        });
        (p as any).exec = function () {
            return p;
        }
        return p;
    }
}

/**
 * funtion to instrument mongoose
 *
 *
 *
 * @param mongoose a real mongoose instance
 * @param [path] {string} optional, a path to write/read files from, defaults to "mgrecrep/"
 * @param mode {string}  undefined (environment value) or "REPLAY" or "RECORD"
 */
export function instrumentMongoose(mongoose: mongoose.Mongoose, path?: string, mode?: string): mongoose.Mongoose {
    theMode = mode || process.env.MONGO_RECORD_REPLAY;
    if (mode && ["REPLAY", "RECORD"].indexOf(mode) < 0) {
        console.log('set only one of MONGO_RECORD MONGO_REPLAY');
        throw new Error('mongoose_record_replay mode should be one of "REPLAY", "RECORD"  was ' + theMode);
    }
    if (theMode === "RECORD") {
        recordingPath = path || process.env.MONGO_RECORD_REPLAY_PATH || "mongoose_record_replay";
        assurePath(recordingPath);
        var omodel = mongoose.model;
        mongoose.model = function () {
            if (arguments.length > 1) {
                return instrumentModel(omodel.apply(mongoose, arguments));
            }
            return omodel.apply(mongoose, arguments);
        }
        return mongoose;
    } else if (theMode === "REPLAY") {
        recordingPath = path || process.env.MONGO_RECORD_REPLAY_PATH || "mongoose_record_replay";
        return mongooseMock as any;
    }
    return mongoose;
}


export var mongooseMock = {
    models: {},
    modelNames: function () {
        return Object.keys(this.models);
    },
    Schema: mongoose.Schema,

    model: function (a, b) {
        if (b === undefined) {
            return this.models[a];
        }
        debuglog('creating model  ' + a + ' at mock');
        this.models[a] = instrumentModel({
            find: function () { },
            aggregate: function () { },
            distinct: function () { },
            modelName: a,
            schema: b,
        } as any);
        return this.models[a];
    },
    disconnect: function () {
        debuglog('simulationg disconnect ');
    },
    connect: function (connStr: string) {
        // this.db.on.emit('on');
        debuglog('simulationg connecting to ' + connStr);
        if (!this._once) {
            var that = this;
            setTimeout(function () {
                that.connection.emit('open');
                debuglog('fired emit');
            }, 0);
        }
    },
    connection: dbEmitter
};