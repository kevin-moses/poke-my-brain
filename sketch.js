let vid;

let videoAssetLength = 4;
let videos = [];
let currentIndex = 0;
function setup() {
    createCanvas(windowWidth, windowHeight);
    for (let i = 0; i < videoAssetLength; i++) {
        videos[i] = createVideo('assets/' + (i+1) + '.mp4');
        videos[i].hide(); // Hide the default HTML player
        videos[i].onended(playNextVideo); 
    }
    videos[currentIndex].play();
}


function draw() {
    background(220);
    image(videos[currentIndex], 0, 0, width, height);
}

// Function to play the next video when the current one ends
function playNextVideo() {
    // Stop the current video explicitly
    videos[currentIndex].stop();
  
    // Move index forward, wrapping back to 0 if at the end
    currentIndex = (currentIndex + 1) % videos.length;
  
    // Play the next video
    videos[currentIndex].play();
    console.log("Playing video index: " + currentIndex);
  }