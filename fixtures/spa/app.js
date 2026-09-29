// Invented SPA for the render_js fixture: the article only exists after this script runs.
(function () {
  document.title = "Orbitdesk: shared inboxes for small support teams";
  var root = document.getElementById("root");
  var html =
    "<article><h1>Orbitdesk: shared inboxes for small support teams</h1>" +
    "<p>Orbitdesk gives a support team of two to twenty people one shared inbox for email, chat and forms. Every conversation gets an owner, a status and a due time, so nothing waits in a personal mailbox.</p>" +
    "<h2>Assign in one keystroke</h2>" +
    "<p>Press A to assign the open conversation to yourself or a teammate. Orbitdesk shows who is already typing a reply, so two people never answer the same customer.</p>" +
    '<div style="height: 2400px"></div>' +
    '<section id="lazy"></section>' +
    '<ul id="probes"></ul>' +
    "</article>";
  root.innerHTML = html;

  // Lazy content: appears only once the page is scrolled.
  var added = false;
  window.addEventListener("scroll", function () {
    if (added || window.scrollY < 200) return;
    added = true;
    document.getElementById("lazy").innerHTML =
      "<h2>Reports that load as you scroll</h2><p>The weekly report counts first-response time per teammate and flags conversations that waited longer than a day.</p>";
  });

  // Probes the render guard must block: a private address and the cloud metadata address.
  function probe(name, url) {
    fetch(url, { mode: "no-cors" }).then(
      function () { report(name, "reached"); },
      function () { report(name, "blocked"); }
    );
  }
  function report(name, result) {
    var li = document.createElement("li");
    li.textContent = "probe " + name + ": " + result;
    document.getElementById("probes").appendChild(li);
  }
  probe("private", "http://10.0.0.5/secret");
  probe("metadata", "http://169.254.169.254/latest/meta-data/");
})();
