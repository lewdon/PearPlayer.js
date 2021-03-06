
/*
 用于调度HttpDownloader和RTCDownloader

 config:{

 initialDownloaders: [],  //初始的httpdownloader数组,必须
 chunkSize: number,       //每个chunk的大小,默认1M
 fileSize: number,        //下载文件的总大小,必须
 interval: number,        //滑动窗口的时间间隔,单位毫秒,默认10s
 auto: boolean,           //true为连续下载buffer,false则是只有当前播放时间与已缓冲时间小于slideInterval时下载buffer,默认false
 slideInterval: number,   //当前播放时间与已缓冲时间小于这个数值时触发窗口滑动,单位秒,默认20s
 useMonitor: boolean      //开启监控器,默认关闭
 }
 */
module.exports = Dispatcher;

var BitField = require('bitfield');
var EventEmitter = require('events').EventEmitter;
var inherits = require('inherits');
var FSChunkStore = require('fs-chunk-store');
var ImmediateChunkStore = require('immediate-chunk-store');

inherits(Dispatcher, EventEmitter);

function Dispatcher(config) {
    EventEmitter.call(this);

    var self = this;

    if (!(config.initialDownloaders && config.fileSize)) throw new Error('config is not completed');
    self.fileSize = config.fileSize;
    self.initialDownloaders = config.initialDownloaders;
    self.pieceLength = config.chunkSize || 1*1024*1024;
    self.interval = config.interval || 10000;
    self._slideInterval = config.slideInterval || 20;           //当前播放点距离缓冲前沿多少秒时滑动窗口
    self.auto = config.auto || false;
    self.useMonitor = config.useMonitor || false;
    self.downloaded = 0;
    self.fogDownloaded = 0;                         //通过data channel下载的字节数
    self._windowOffset = 0;
    // self.noDataChannel = false;    //是否没有datachannel
    self.ready = false;
    self.done = false;             //是否已完成下载
    self.destroyed = false;

    self.chunks = (config.fileSize % self.pieceLength)>0 ? Math.floor((config.fileSize / self.pieceLength)) +1:
        (config.fileSize / self.pieceLength);

    // self._startPiece = 0;
    // self._endPiece = (self.fileSize-1)/self.pieceLength;

    self._selections = [];                           //下载队列
    self._store = FSChunkStore;
    self.elem = null;                          //video标签的id
    self.video = null;
    self.path = '';
    self._bufferedPos = 0;                     //当前所在的缓冲区间
    self._lastSlideTime = -5;                  //上次滑动窗口的时间
    self.bufferSources = new Array(self.chunks);    //记录每个buffer下载的方式
    self.slide = null;
    self.bufferingCount = 0;                   //视频卡的次数
    self.noMoreNodes = false;                   //是否已没有新的节点可获取

    //firstaid参数自适应
    self._windowLength = self.initialDownloaders.length <= 8 ? self.initialDownloaders.length : 8;
    // self._windowLength = 15;
    // self._colddown = self._windowLength;                        //窗口滑动的冷却时间
    self._colddown = 12;                        //窗口滑动的冷却时间
    self.downloaders = [];
    self.bitrate = 0;                         //码率

    //webtorrent
    self.torrent = null;

    //减少重复下载
    self._interval2BufPos = 0;                                  //当前播放点距离缓冲前沿的时间，单位秒
    self.lastStartIdx = -1;                                       //记录上个startFrom的索引
};

Dispatcher.prototype._init = function () {
    var self = this;

    // for (var i=0;i<self.initialDownloaders.length;++i){
    //     var hd = self.initialDownloaders[i];
    //     self._setupHttp(hd);
    //     self.downloaders.push(hd);
    // }

    self.downloaders = self.initialDownloaders.map(function (item){

        self._setupHttp(item);
        return item;
    });

    self.store = new ImmediateChunkStore(
        new self._store(self.pieceLength, {
            path: self.path,
            length: self.fileSize
        })
    );
    console.log('self.path:'+self.path);
    self.bitfield = new BitField(self.chunks);       //记录哪个块已经下好

    self.queue = [];                     //初始化下载队列
    // self._slide();
    if (self.auto) {
        self.startFrom(0, false);
        self.autoSlide();
        self.slide = noop;
    } else {
        self.slide = this._throttle(this._slide, this);
    }

    //初始化video
    self.video = document.querySelector(self.elem);
    self.video.addEventListener('loadedmetadata', function () {

        console.info('loadedmetadata duration:' + self.video.duration);
        self.bitrate = Math.ceil(self.fileSize/self.video.duration);
        self._windowLength = Math.ceil(self.bitrate * 15 / self.pieceLength);       //根据码率和时间间隔来计算窗口长度
        if (self._windowLength < 3) {
            self._windowLength = 3;
        } else if (self._windowLength > 10) {
            self._windowLength = 10;
        }
        // self._colddown = 5/self._slideInterval*self._interval2BufPos + 5;                        //窗口滑动的冷却时间
        // self._colddown = self._windowLength*2;
        self._colddown = 5;
        self.emit('loadedmetadata');
    });
    self.video.addEventListener('seeked', function () {
        console.info('video seeked');

        var currentTime = Math.floor(self.video.currentTime);
        for (var index=0;index<self.video.buffered.length;++index) {
            // console.log('currentTime:' + currentTime + ' Math.floor(self.video.buffered.start(index)):' + Math.floor(self.video.buffered.start(index)));
            if (currentTime >= Math.floor(self.video.buffered.start(index))) {

                self._bufferedPos = index;
                // console.log('_bufferedPos:' + self._bufferedPos);
            }
            // self.bufferedPos = self.video.buffered.length-1;
        }
        // self._slide();

    });
    self.video.addEventListener('timeupdate', function () {

        var bool = self._shouldFetchNextSegment();
        // console.log('_shouldFetchNextSegment:'+bool);
        if (bool){
            self.slide();
            // console.log('timeupdate slide');
            // self._throttle(self.slide,self);
            // self._update();
            self._lastSlideTime = self.video.currentTime;
        }
    });
    self.video.addEventListener('waiting', function () {

        console.info('waiting for buffer');
        // self.requestMoreNodes();
        for (var j=0;j<self.downloaders.length;++j) {
            console.log('downloaders type:' + self.downloaders[j].type + ' mean speed:' +self.downloaders[j].meanSpeed);
        }
        if (self.downloaders.length === 1) {               //如果只有一个downloader,则改为串行下载
            self.downloaders[0].isAsync = false;
        }
        // self.bufferingCount ++;
        // console.info('bufferingCount:' + self.bufferingCount);
        // if (self.bufferingCount >= 5) {
        //     self.startFrom(0, false);
        //     self.autoSlide();
        //     self.slide = noop;
        //     self.bufferingCount = Number.MIN_VALUE;
        // }

    });

    //初始化buffersources
    for (var k=0;k<self.bufferSources;++k) {
        self.bufferSources[k] = null;
    }

    self.ready = true;
    self.emit('ready', self.chunks);
};

Dispatcher.prototype.startFrom = function (start, priority, notify) {  //start和end是指index
    var self = this;
    if (self.destroyed) throw new Error('dispatcher is destroyed');

    // var length = self._selections.length;
    // if ( length > 0) {
    //
    //     var s = self._selections[length-1];
    //     // var start = s.from + s.offset;
    //     console.log('start:'+self._calIndex(start)+' s.from:'+self._calIndex(s.from));
    //     if (self._calIndex(start) === self._calIndex(s.from)) {
    //         console.log('startFrom return');
    //         return;
    //     }
    // }
    if (start === self.lastStartIdx) {           //如果这次的start和上次一样，则不滑动窗口
        return;
    }
    self.lastStartIdx = start;

    priority = Number(priority) || 0;
    self._selections.push({
        from: start,
        to: self.chunks-1,
        offset: 0,
        priority: priority,
        notify: notify || noop
    });
    console.log('Dispatcher startFrom');
    self._selections.sort(function (a, b) {           //从小到大排列
        return a.priority - b.priority
    });
    // console.log('self._selections'+JSON.stringify(self._selections));
    self._updateSelections();
};

Dispatcher.prototype.deStartFrom = function (start, priority) {
    var self = this;
    if (self.destroyed) throw new Error('dispatcher is destroyed');

    if (start === self.lastStartIdx) {           //如果这次的start和上次一样，则不deStartFrom
        return;
    }

    priority = Number(priority) || 0;
    console.log('deselect '+start);
    self._clearAllQueues();
    self._abortAll();
    for (var i = 0; i < self._selections.length; ++i) {
        var s = self._selections[i];
        if (s.from === start && s.to === self.chunks-1 && s.priority === priority) {
            self._selections.splice(i, 1);
            break
        }
    }

    self._updateSelections()
};

Dispatcher.prototype._slide = function () {
    var self = this;

    // if (self.done || self.video.paused) return;
    if (self.done) return;
    // console.log('[dispatcher] slide window downloader length:'+self.downloaders.length);
    self._fillWindow();
};

/**
 * Called on selection changes.
 */
Dispatcher.prototype._updateSelections = function () {
    var self = this;
    if (!self.ready || self.destroyed) return;

    if (!self.ready) return;

    process.nextTick(function () {
        self._gcSelections()
    });
    console.log('Dispatcher _updateSelections');
    //此处开始下载
    self._update();
};

/**
 * Garbage collect selections with respect to the store's current state.
 */
Dispatcher.prototype._gcSelections = function () {
    var self = this;

    // for (var i = 0; i < self._selections.length; ++i) {
    //     var s = self._selections[i];
    //     var oldOffset = s.offset;
    //
    //     // check for newly downloaded pieces in selection
    //     while (self.bitfield.get(s.from + s.offset) && s.from + s.offset < s.to) {
    //         s.offset += 1
    //     }
    //
    //     if (oldOffset !== s.offset) s.notify();
    //     if (s.to !== s.from + s.offset) continue;
    //     if (!self.bitfield.get(s.from + s.offset)) continue;
    //
    //     self._selections.splice(i, 1); // remove fully downloaded selection
    //     i -= 1; // decrement i to offset splice
    //
    //     s.notify();
    // }

    // for (var i = 0; i < self._selections.length; ++i) {
    //test
        var s = self._selections[self._selections.length-1];
        var oldOffset = s.offset;

        // check for newly downloaded pieces in selection
        while (self.bitfield.get(s.from + s.offset) && s.from + s.offset < s.to) {
            s.offset += 1
        }
        self._windowOffset = s.from + s.offset;

        if (oldOffset !== s.offset) s.notify();
        // if (s.to !== s.from + s.offset) continue;
        // if (!self.bitfield.get(s.from + s.offset)) continue;
        //
        // self._selections.splice(i, 1); // remove fully downloaded selection
        // i -= 1; // decrement i to offset splice

        s.notify();
    // }

    // self._windowOffset = s.from + s.offset;
    // console.log('current _windowOffset:' + self._windowOffset);

    if (!self._selections.length) self.emit('idle')
};

Dispatcher.prototype._update = function () {
    var self = this;
    if (self.destroyed) return;
    console.log('Dispatcher _update');
    var length = self._selections.length;
    console.log('_selections.length:'+self._selections.length);
    if ( length > 0) {

        // console.log('_update self._selections:'+JSON.stringify(self._selections));
        var s = self._selections[length-1];
        var start = s.from + s.offset;
        // // var end = s.to;
        self._windowOffset = start;
        console.log('current _windowOffset:' + self._windowOffset);
        self._slide();
        // self.slide();
        // self._throttle(self.slide,self);
    }

};

Dispatcher.prototype._checkDone = function () {
    var self = this;
    if (self.destroyed) return;
    // is the torrent done? (if all current selections are satisfied, or there are
    // no selections, then torrent is done)
    var done = true;
    for (var i = 0; i < self._selections.length; i++) {
        var selection = self._selections[i];
        for (var piece = 0; piece <= selection.to; piece++) {
            if (!self.bitfield.get(piece)) {
                done = false;
                break
            }
        }
        if (!done) break
    }
    console.log('_checkDone self.done:'+self.done+' done:'+done);
    if (!self.done && done) {
        self.done = true;
        // console.log('dispatcher done');
        self.emit('done');
        if (self.useMonitor) {
            self.emit('downloaded', 1.0);
        }
    }
    self._gcSelections();

    return done;
};

Dispatcher.prototype._calRange = function (index) {            //根据索引计算范围
    var self = this;

    var begin= index*self.pieceLength;
    var end = (index+1)*self.pieceLength - 1;
    if(index == (self.chunks-1))
    {
        end = index*self.pieceLength + self.fileSize%self.pieceLength - 1;
    }
    return [begin, end];
};

Dispatcher.prototype._calIndex = function (start) {            //根据范围计算索引
    var self = this;

    return Math.floor(start/self.pieceLength);
};

Dispatcher.prototype._getNodes = function (index) {      //返回节点构成的数组

    return this.downloaders[index % this.downloaders.length];
};

Dispatcher.prototype._fillWindow = function () {
    var self = this;

    var sortedNodes = sortByIdleFirst(this.downloaders);     //已经按某种策略排好序的节点数组，按优先级降序
    if (sortedNodes.length === 0) return;
    // if (sortedNodes.length > 10) {
    //     var mean = sortedNodes.getMeanSpeed();
    //     sortedNodes = sortedNodes.filter(function (item) {
    //         return item.meanSpeed === -1 || item.meanSpeed >= mean*0.5;
    //     })
    // }
    if (self._interval2BufPos > self._slideInterval*2/3) {            //在缓冲流畅的情况下不使用server节点
        sortedNodes = sortedNodes.filter(function (item) {
            return item.type !== 'server';
        })
    }

    var count = 0;
    console.log('_fillWindow _windowOffset:' + self._windowOffset + ' downloaders:'+self.downloaders.length);
    var index = self._windowOffset;                       //TODO:修复auto下为零
    console.log('sortedNodes length:'+sortedNodes.length);
    while (count !== self._windowLength){
        console.log('_fillWindow _windowLength:'+self._windowLength + ' downloadersLength:' + self.downloaders.length);
        if (index >= self.chunks){
            break;
        }

        if (count >= sortedNodes.length) break;

        if (!self.bitfield.get(index)) {

            var pair = self._calRange(index);
            // var node = self._getNodes(count);
            // node.select(pair[0],pair[1]);
            var node = sortedNodes[count];
            console.log('_fillWindow node downloading:'+node.downloading+' meanspeed:'+node.meanSpeed+' queue:'+node.queue.length);
            node.select(pair[0],pair[1]);
            count ++;
        } else {

        }
        index ++;
    }


    function sortByIdleFirst(arr) {

        arr.sort(function (a, b) {           //从大到小排列

            return b.meanSpeed - a.meanSpeed;
        });

        var idles = arr.filter(function (item) {
            return item.downloading === false;
        });
        var busys = arr.filter(function (item) {
            return item.downloading === true;
        });
        return idles.concat(busys).filter(function (item) {
            return item.queue.length <= 2;
        });
    }
};

Dispatcher.prototype._setupHttp = function (hd) {
    var self = this;

    hd.on('start',function () {

    });
    hd.on('done',function () {

        // console.log('httpDownloader ondone');

    });
    hd.on('error', function (error) {

        console.warn('hd error!');

        if (self.downloaders.length > self._windowLength) {
            self.downloaders.removeObj(hd);
            if (self._windowLength > 3) self._windowLength --;
        }
        self.checkoutDownloaders();
    });
    hd.on('data',function (buffer, start, end, speed) {

        var index = self._calIndex(start);
        console.log('httpDownloader' + hd.uri +' ondata range:'+start+'-'+end+' at index:'+index+' speed:'+hd.meanSpeed);
        var size = end - start + 1;
        if (!self.bitfield.get(index)){
            self.bitfield.set(index,true);
            // self.emit('bitfieldchange', self.bitfield);
            try {
                self.store.put(index, buffer);
            } catch (e){
                console.error('store error:'+e);
            }
            //test
            

            self._checkDone();
            if (self.useMonitor) {
                self.downloaded += size;
                self.emit('downloaded', self.downloaded/self.fileSize);
                // hd.downloaded += size;
                self.emit('traffic', hd.mac, size, 'HTTP');
                console.log('ondata hd.type:' + hd.type +' index:' + index);
                if (hd.type === 'node' || hd.type === 'browser') {
                    self.fogDownloaded += self.pieceLength;
                    self.emit('fograte', self.fogDownloaded/self.downloaded);
                    self.emit('fogspeed', self.downloaders.getMeanSpeed(['node', 'datachannel']));
                    hd.type === 'node' ? self.bufferSources[index] = 'n' : self.bufferSources[index] = 'b';
                } else {
                    self.emit('cloudspeed', self.downloaders.getMeanSpeed(['server']));
                    self.bufferSources[index] = 's'
                }
                self.emit('buffersources', self.bufferSources);
                self.emit('sourcemap', hd.type === 'node' ? 'n' : 's', index);
            }
            // console.log('bufferSources:'+self.bufferSources);
        } else {
            console.log('重复下载');

        }
    });

    return hd;
};

Dispatcher.prototype._setupDC = function (jd) {
    var self = this;

    jd.on('start',function () {
        // console.log('DC start downloading');
    });

    jd.on('data',function (buffer, start, end, speed) {

        var index = self._calIndex(start);
        console.log('pear_webrtc '+jd.dc_id+' ondata range:'+start+'-'+end+' at index:'+index+' speed:'+jd.meanSpeed);
        var size = end - start + 1;
        if (!self.bitfield.get(index)){
            self.bitfield.set(index,true);
            // self.emit('bitfieldchange', self.bitfield);
            try {
                self.store.put(index, buffer);
            } catch (e){

            }
            self._checkDone();
            if (self.useMonitor) {
                self.downloaded += size;
                self.fogDownloaded += size;
                console.log('downloaded:'+self.downloaded+' fogDownloaded:'+self.fogDownloaded);
                self.emit('downloaded', self.downloaded/self.fileSize);
                self.emit('fograte', self.fogDownloaded/self.downloaded);
                self.emit('fogspeed', self.downloaders.getMeanSpeed(['node','browser','datachannel']));
                self.bufferSources[index] = 'd';
                self.emit('buffersources', self.bufferSources);
                self.emit('sourcemap', 'd', index);
                // jd.downloaded += size;
                self.emit('traffic', jd.mac, size, 'WebRTC');
            }
        } else {
            console.log('重复下载');
            for (var k=0;k<self.downloaders.length;++k) {
                if (self.downloaders[k].type === 'datachannel') {
                    self.downloaders[k].clearQueue();                //如果dc下载跟不上http,则清空下载队列
                }

            }
        }

    });

    jd.on('error', function () {
        console.warn('jd error '+ jd.mac);
        jd.close();
        self.downloaders.removeObj(jd);
        if (self._windowLength > 3) {
            self._windowLength --;
        }
        self.checkoutDownloaders();

    });
};

Dispatcher.prototype.checkoutDownloaders = function () {            //TODO:防止重复请求

    if (this.downloaders.length <= 3 && !this.noMoreNodes) {
        this.requestMoreNodes();
        this.requestMoreDataChannels();
        if (this.downloaders.length <= 2 && this._windowLength / this.downloaders.length >= 2) {
            this.emit('needsource');
        }
    }
};

Dispatcher.prototype.addTorrent = function (torrent) {
    var self = this;
    // console.log('torrent.pieces.length:'+torrent.pieces.length+' chunks:'+this.chunks);
    if (torrent.pieces.length !== this.chunks) return;
    this.torrent = torrent;
    torrent.pear_downloaded = 0;
    console.log('addTorrent _windowOffset:' + self._windowOffset);
    if (self._windowOffset + 10 < torrent.pieces.length-1) {
        torrent.select(self._windowOffset+10, torrent.pieces.length-1, 1000, function () {

        });
    }
    torrent.on('piecefromtorrent', function (index) {

        console.log('piecefromtorrent:'+index);
        if (self.useMonitor) {
            self.downloaded += self.pieceLength;
            self.fogDownloaded += self.pieceLength;
            torrent.pear_downloaded += self.pieceLength;
            // console.log('downloaded:'+self.downloaded+' fogDownloaded:'+self.fogDownloaded);
            self.emit('downloaded', self.downloaded/self.fileSize);
            self.emit('fograte', self.fogDownloaded/self.downloaded);
            // console.log('torrent.downloadSpeed:'+torrent.downloadSpeed/1024);
            self.emit('fogspeed', self.downloaders.getMeanSpeed(['node', 'datachannel']) + torrent.downloadSpeed/1024);
            self.bufferSources[index] = 'b';
            self.emit('buffersources', self.bufferSources);
            self.emit('sourcemap', 'b', index);
            self.emit('traffic', 'Webtorrent', self.pieceLength, 'Browser');
        }
    });

    torrent.on('done', function () {
        console.log('torrent done');
    });
};

Dispatcher.prototype.addDataChannel = function (dc) {

    // this.downloaders.push(dc);
    this.downloaders.splice(this._windowLength-1,0,dc);
    if (this._windowLength < 10) {
        this._windowLength ++;
    }
    console.log('addDataChannel _windowLength:' + this._windowLength);
    this._setupDC(dc);
    console.log('addDataChannel now:'+this.downloaders.length);
    for (var i=0;i<this.downloaders.length;++i) {
        console.log('downloader type:'+this.downloaders[i].type);
    }
};

Dispatcher.prototype.addNode = function (node) {     //node是httpdownloader对象

    this._setupHttp(node);
    this.downloaders.push(node);
    console.log('dispatcher add node: '+node.uri);

};

Dispatcher.prototype.requestMoreNodes = function () {

    if (this.downloaders.length > 0) {            //节点不够,重新请求
        this.emit('needmorenodes');
    } else {
        this.emit('error');
    }
};

Dispatcher.prototype.requestMoreDataChannels = function () {

    if (this.downloaders.length > 0) {            //节点不够,重新请求
        this.emit('needmoredatachannels');
    } else {
        this.emit('error');
    }
};

Dispatcher.prototype.destroy = function () {
    var self = this;
    if (self.destroyed) return;
    self.destroyed = true;

    for (var k=0;k<self.downloaders.length;++k) {
        self.downloaders[k].close();
    }
    if (self.store) {
        self.store.close();
    }

    self.emit('close');

    self.store = null;
    // self.video = null;
    console.info('Dispatcher destroyed');
};

Dispatcher.prototype._throttle = function (method, context) {

    var going = false;
    return function () {
        if (going) return;
        going = true;
        setTimeout(function(){
            method.call(context);
            going = false;
        }, this._colddown*1000);
    }
};

Dispatcher.prototype.autoSlide = function () {
    var self = this;

    setTimeout(function () {
        // console.log('[dispatcher] auto slide');
        self._slide();
        self._checkDone();
        if (!self.done && !self.destroyed){
            setTimeout(arguments.callee, self._colddown*1000);
        }
    }, self._colddown*1000);
};

Dispatcher.prototype._shouldFetchNextSegment = function() {
    var self = this;
    // if (self.bufferedPos === -1) return true;
    // console.log('this.video.buffered.end(this._bufferedPos):'+this.video.buffered.end(this._bufferedPos)+' this.video.currentTime:'+this.video.currentTime)
    try {
        this._interval2BufPos = this.video.buffered.end(this._bufferedPos) - this.video.currentTime;
        return this._interval2BufPos < this._slideInterval;
    } catch (e) {
        console.warn('_shouldFetchNextSegment exception');
        return true;
        // return false;
    };
};

Dispatcher.prototype._clearAllQueues = function () {

    for (var k=0;k<this.downloaders.length;++k) {
        this.downloaders[k].clearQueue();
    }
};

Dispatcher.prototype._abortAll = function () {

    for (var k=0;k<this.downloaders.length;++k) {
        this.downloaders[k].abort();
    }
};

function noop () {}

Array.prototype.removeObj = function (_obj) {
    var length = this.length;
    for(var i = 0; i < length; i++)
    {
        if(this[i] == _obj)
        {
            this.splice(i,1); //删除下标为i的元素
            break
        }
    }
};

Array.prototype.getMeanSpeed = function (typeArr) {              //根据传输的类型(不传则计算所有节点)来计算平均速度
    var sum = 0;
    var length = 0;
    if (typeArr) {
        for (var i = 0; i < this.length; i++) {
            if (typeArr.indexOf(this[i].type) >= 0) {
                sum+=this[i].meanSpeed;
                length ++;
            }
        }
    } else {
        for (var i = 0; i < this.length; i++) {
            sum+=this[i].meanSpeed;
            length ++;
        }
    }
    return Math.floor(sum/length);
};

