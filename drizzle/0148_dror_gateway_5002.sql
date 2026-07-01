-- Point Dror gateway to IBIND2 (5001 is paper; 5002 is Dror dormant)
UPDATE `ibkrGateways` SET `baseUrl` = 'http://127.0.0.1:5002' WHERE `slug` = 'dror';
