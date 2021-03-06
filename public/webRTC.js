function getParameterByName(name, url) {
    if (!url) url = window.location.href;
    name = name.replace(/[\[\]]/g, "\\$&");
    var regex = new RegExp("[?&]" + name + "(=([^&#]*)|&|#|$)"),
        results = regex.exec(url);
    if (!results) return null;
    if (!results[2]) return '';
    return decodeURIComponent(results[2].replace(/\+/g, " "));
}
var fileInput = document.querySelector('input#fileInput');
var downloadAnchor = document.querySelector('a#download');

// this function use to get url parameters


var room = getParameterByName('room');
var IDUser = getParameterByName('userid');
var name = getParameterByName('name');
/** CONFIG **/
var SIGNALING_SERVER = "https://0.0.0.0:8443"; //your  node server addres  or  IP adress
var USE_AUDIO = true;
var USE_VIDEO = true;
var MUTE_AUDIO_BY_DEFAULT = false;
/** You should probably use a different stun server doing commercial stuff **/
/** Also see: https://gist.github.com/zziuni/3741933 **/
var ICE_SERVERS = [
    {urls: "stun:stun.l.google.com:19302"},
    // {
    //     urls: 'turn:numb.viagenie.ca:3489',
    //     credential: '12344', //your  password
    //     username: 'your@email.com'
    // }
];
var socket = null;
/* our socket.io connection to our webserver */
var local_media_stream = null;
/* our own microphone / webcam */
var peers = {};
/* keep track of our peer connections, indexed by peer_id (aka socket.io id) */
var peer_media_elements = {};
/* keep track of our <video>/<audio> tags, indexed by peer_id */
function init(a) {
    // socket = io(SIGNALING_SERVER);
    socket = io();
    //----------------------------------------------------------------------->>>>> Files Send Start
    const BYTES_PER_CHUNK = 1200;
    var file;
    var currentChunk;
    var fileInput = document.querySelector('input[type=file]');
    var fileReader = new FileReader();

    function readNextChunk() {
        var start = BYTES_PER_CHUNK * currentChunk;
        var end = Math.min(file.size, start + BYTES_PER_CHUNK);
        fileReader.readAsArrayBuffer(file.slice(start, end));
    }

    fileReader.onload = function () {
        socket.emit('file-send-room-result', fileReader.result);
        //p2pConnection.send( fileReader.result );
        currentChunk++;
        if (BYTES_PER_CHUNK * currentChunk < file.size) {
            readNextChunk();
        }
    };
    fileInput.addEventListener('change', function () {
        file = fileInput[0].files[0];
        currentChunk = 0;
        // send some metadata about our file
        // to the receiver
        socket.emit('file-send-room', JSON.stringify({
            fileName: file.name,
            fileSize: file.size
        }));
        readNextChunk();
    });
    var incomingFileInfo;
    var incomingFileData;
    var bytesReceived;
    var downloadInProgress = false;
    socket.on('file-out-room', function (data) {
        startDownload(data);

        console.log(data);
    });
    socket.on('file-out-room-result', function (data) {
        progressDownload(data);
        console.log(data);            });
    function startDownload(data) {
        incomingFileInfo = JSON.parse(data.toString());
        incomingFileData = [];
        bytesReceived = 0;
        downloadInProgress = true;
        console.log('incoming file <b>' + incomingFileInfo.fileName + '</b> of ' + incomingFileInfo.fileSize + ' bytes');
    }

    function progressDownload(data) {
        bytesReceived += data.byteLength;
        incomingFileData.push(data);
        console.log('progress: ' + ((bytesReceived / incomingFileInfo.fileSize ) * 100).toFixed(2) + '%');
        if (bytesReceived === incomingFileInfo.fileSize) {
            endDownload();
        }
    }

    function endDownload() {
        downloadInProgress = false;
        var blob = new Blob(incomingFileData);
       
        var a = document.createElement("a");
        document.body.appendChild(a);
        a.style = "display: none";
        var blob = new Blob(incomingFileData);
        var url = window.URL.createObjectURL(blob);
        a.href = url;
        a.download = incomingFileInfo.fileName;
        a.click();
        window.URL.revokeObjectURL(url);
    }

    //==================================================================<<< Filse Send End
    //------------------------ Funtion
    function join_chat_channel(channel, userdata) {
        socket.emit('join-room', {"channel": channel, "userdata": userdata});
    }

    socket.on('connect', function (userID) {
        console.log("Connected to signaling server");
        setup_local_media(function () {
            /* once the user has given us access to their
             * microphone/camcorder, join the channel and start peering up */
            join_chat_channel(room, {'name': name, 'userID': IDUser});
        });
    });
    socket.on('room-users', function (data) {
        console.log(data);
        document.getElementById("online-user").innerHTML = "<table>" + data.map(user => `<tr id="${user.peer_id}" ><td>Name = ${user.name} User ID=${user.userID}</td><td><button class="call" id="${user.userID}">Call</button></td></tr>`).join("") + "</table>";
    });
    document.querySelector('body').addEventListener('click', function (e) {
        if (e.target.classList.contains('call')) {
            var callerID = e.target.id;
            socket.emit('call', {"callToId": callerID, "callFromId": IDUser});
        }
    });
    /**
     * When we join a group, our signaling server will send out 'addPeer' events to each pair
     * of users in the group (creating a fully-connected graph of users, ie if there are 6 people
     * in the channel you will connect directly to the other 5, so there will be a total of 15
     * connections in the network).
     */
    socket.on('addPeer-room', function (config) {
        console.log('Signaling server said to add peer:', config);
        var peer_id = config.peer_id;
        if (peer_id in peers) {
            /* This could happen if the user joins multiple channels where the other peer is also in. */
            console.log("Already connected to peer ", peer_id);
            return;
        }
        var peer_connection = new RTCPeerConnection(
            {"iceServers": ICE_SERVERS},
            {"optional": [{"DtlsSrtpKeyAgreement": true}]} /* this will no longer be needed by chrome
                 * eventually (supposedly), but is necessary
                 * for now to get firefox to talk to chrome */
        );
        peers[peer_id] = peer_connection;
        peer_connection.onicecandidate = function (event) {
            if (event.candidate) {
                socket.emit('relayICECandidate-room', {
                    'peer_id': peer_id,
                    'ice_candidate': {
                        'sdpMLineIndex': event.candidate.sdpMLineIndex,
                        'candidate': event.candidate.candidate
                    }
                });
            }
        }
        peer_connection.onaddstream = function (event) {
            console.log("onAddStream", event);
            var remote_media = USE_VIDEO ? document.createElement("video") : document.createElement("audio");
            remote_media.setAttribute("autoplay", "autoplay");
            if (MUTE_AUDIO_BY_DEFAULT) {
                remote_media.setAttribute("muted", "true");
            }
            remote_media.setAttribute("controls", "");
            peer_media_elements[peer_id] = remote_media;
            document.body.appendChild(remote_media);
            attachMediaStream(remote_media[0], event.stream);
        }
        /* Add our local stream */
        peer_connection.addStream(local_media_stream);
        /* Only one side of the peer connection should create the
         * offer, the signaling server picks one to be the offerer.
         * The other user will get a 'sessionDescription' event and will
         * create an offer, then send back an answer 'sessionDescription' to us
         */
        if (config.should_create_offer) {
            console.log("Creating RTC offer to ", peer_id);
            peer_connection.createOffer().then(function (local_description) {
                console.log("Local offer description is: ", local_description);
                peer_connection.setLocalDescription(local_description,
                    function () {
                        socket.emit('relaySessionDescription-room',
                            {'peer_id': peer_id, 'session_description': local_description});
                        console.log("Offer setLocalDescription succeeded");
                    },
                    function () {
                        Alert("Offer setLocalDescription failed!");
                    }
                );
            }).catch(function (error) {
                console.log("Error sending offer: ", error);
            });
        }
    });
    /**
     * Peers exchange session descriptions which contains information
     * about their audio / video settings and that sort of stuff. First
     * the 'offerer' sends a description to the 'answerer' (with type
     * "offer"), then the answerer sends one back (with type "answer").
     */
    socket.on('sessionDescription-room', function (config) {
        console.log('Remote description received: ', config);
        var peer_id = config.peer_id;
        var peer = peers[peer_id];
        var remote_description = config.session_description;
        console.log(config.session_description);
        var desc = new RTCSessionDescription(remote_description);
        console.log(desc)
        var stuff = peer.setRemoteDescription(desc)
        .then(function () {
                console.log("setRemoteDescription succeeded");
                if (remote_description.type == "offer") {
                    console.log("Creating answer");
                    peer.createAnswer().then(
                        function (local_description) {
                            console.log("Answer description is: ", local_description);
                            peer.setLocalDescription(local_description,
                                function () {
                                    socket.emit('relaySessionDescription-room',
                                        {'peer_id': peer_id, 'session_description': local_description});
                                    console.log("Answer setLocalDescription succeeded");
                                },
                                function () {
                                    Alert("Answer setLocalDescription failed!");
                                }
                            );
                        }).catch(
                        function (error) {
                            console.log("Error creating answer: ", error);
                            console.log(peer);
                        });
                }
            }
        ).catch(function (error) {
                console.log("setRemoteDescription error: ", error);
            }
        );
        console.log("Description Object: ", desc);
    });
    /**
     * The offerer will send a number of ICE Candidate blobs to the answerer so they
     * can begin trying to find the best path to one another on the net.
     */
    socket.on('iceCandidate-room', function (config) {
        console.log('ice-candidate received')
        var peer = peers[config.peer_id];
        var ice_candidate = config.ice_candidate;
        peer.addIceCandidate(new RTCIceCandidate(ice_candidate));
    });
    /**
     * When a user leaves a channel (or is disconnected from the
     * signaling server) everyone will recieve a 'removePeer' message
     * telling them to trash the media channels they have open for those
     * that peer. If it was this client that left a channel, they'll also
     * receive the removePeers. If this client was disconnected, they
     * wont receive removePeers, but rather the
     * signaling_socket.on('disconnect') code will kick in and tear down
     * all the peer sessions.
     */
    socket.on('removePeer-room', function (config) {
        console.log('Signaling server said to remove peer:', config);
        var peer_id = config.peer_id;
        if (peer_id in peer_media_elements) {
            peer_media_elements[peer_id].remove();
        }
        if (peer_id in peers) {
            peers[peer_id].close();
        }
        delete peers[peer_id];
        delete peer_media_elements[config.peer_id];
        let elem = document.getElementById(peer_id);
        elem.parentNode.removeChild(elem);
    });
}
function setup_local_media(callback, errorback) {
    if (local_media_stream != null) {  /* ie, if we've already been initialized */
        if (callback) callback();
        return;
    }
    /* Ask user for permission to use the computers microphone and/or camera,
     * attach it to an <audio> or <video> tag if they give us access. */
    console.log("Requesting access to local audio / video inputs");
    attachMediaStream = function (element, stream) {
        element.srcObject = stream;
    };
    navigator.mediaDevices.getUserMedia({"audio": USE_AUDIO, "video": USE_VIDEO}).then(
        function (stream) { /* user accepted access to a/v */
            console.log("Access granted to audio/video");
            local_media_stream = stream;
            var local_media = USE_VIDEO ? document.createElement("video") : document.createElement("audio");
            local_media.setAttribute("autoplay", "autoplay");
            local_media.setAttribute("muted", "true");
            /* always mute ourselves by default */
            local_media.setAttribute("controls", "");
            document.body.appendChild(local_media);
            attachMediaStream(local_media[0], stream);
            if (callback) callback();
        },
        function () { /* user denied access to a/v */
            console.log("Access denied for audio/video");
            alert("You chose not to provide access to the camera/microphone, demo will not work.");
            if (errorback) errorback();
        });
}
document.addEventListener("DOMContentLoaded", init)